import { randomUUID } from "node:crypto";
import { handleOptions, readBody, setCors, supabaseAdmin } from "../_lib/supabase.js";
import { paymentCapture, recordSale, toolById } from "../_lib/proofline-commerce.js";

export default async function handler(req, res) {
  setCors(res);
  if (handleOptions(req, res)) return;
  if (req.method !== "POST") {
    res.status(405).json({ error: "Method not allowed" });
    return;
  }

  try {
    const tool = toolById("request_fresh_audit");
    const db = supabaseAdmin();
    const input = await readBody(req);
    const payment = paymentCapture(req, tool);
    const requestRecord = await recordCommerceRequest(db, req, input, payment);
    const queuedJob = await maybeQueueAuditJob(db, input);
    const output = {
      requestId: requestRecord.request_id,
      queuedAuditJobId: queuedJob?.auditJobId ?? null,
      status: queuedJob ? "queued" : "recorded",
      note: queuedJob
        ? "Fresh audit request recorded and queued in Supabase audit_jobs."
        : "Fresh audit request recorded. Provide targetAgentId, name, endpoint, toolId, price, currency, and paymentMethod to queue automatically.",
    };
    const sale = await recordSale(db, req, tool, null, output, payment);
    res.status(200).json({ status: "success", sale, payment, data: output });
  } catch (error) {
    res.status(500).json({ error: error instanceof Error ? error.message : String(error) });
  }
}

async function recordCommerceRequest(db, req, input, payment) {
  const buyerWallet = req.headers["x-buyer-wallet"] ?? req.headers["x-wallet"] ?? null;
  const { data, error } = await db
    .from("commerce_requests")
    .insert({
      buyer_wallet: typeof buyerWallet === "string" ? buyerWallet : null,
      requested_tool: "request_fresh_audit",
      input,
      output: { payment },
      status: "recorded",
    })
    .select("request_id")
    .single();
  if (error) throw new Error(`Failed to record commerce request: ${error.message}`);
  return data;
}

async function maybeQueueAuditJob(db, input) {
  const target = normalizeTarget(input);
  if (!target) return null;

  const job = {
    auditJobId: `job_${randomUUID()}`,
    target,
    status: "queued",
    createdAt: new Date().toISOString(),
    maxSpendUsdc: Number(process.env.MAX_SPEND_PER_AUDIT_USDC ?? 0.35),
  };
  const { error } = await db.from("audit_jobs").upsert(
    {
      audit_job_id: job.auditJobId,
      target_key: `${target.agentId}::${target.toolId}`,
      status: job.status,
      max_spend_usdc: job.maxSpendUsdc,
      created_at: job.createdAt,
      updated_at: job.createdAt,
      payload: job,
    },
    { onConflict: "audit_job_id" },
  );
  if (error) throw new Error(`Failed to queue requested audit job: ${error.message}`);
  return job;
}

function normalizeTarget(input) {
  if (!input || typeof input !== "object") return null;
  const agentId = stringField(input, "targetAgentId") ?? stringField(input, "agentId");
  const name = stringField(input, "name") ?? stringField(input, "targetName");
  const endpoint = stringField(input, "endpoint");
  const toolId = stringField(input, "toolId") ?? "requested";
  const price = stringField(input, "price") ?? stringField(input, "pricePerCallDisplay");
  const currency = stringField(input, "currency") ?? "USDC";
  const paymentMethod = stringField(input, "paymentMethod") ?? "x402";
  if (!agentId || !name || !endpoint || !price) return null;
  return {
    agentId,
    name,
    toolId,
    toolName: stringField(input, "toolName") ?? toolId,
    description: stringField(input, "description") ?? "Queued through Proofline request_fresh_audit.",
    category: stringField(input, "category") ?? "sap_agent",
    price,
    currency,
    paymentMethod,
    endpoint,
    source: "sap_discovery",
  };
}

function stringField(value, key) {
  const field = value[key];
  return typeof field === "string" && field.length > 0 ? field : null;
}
