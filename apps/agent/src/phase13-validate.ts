import { createHash, createPublicKey, verify as cryptoVerify } from "node:crypto";
import { createClient } from "@supabase/supabase-js";
import { PublicKey } from "@solana/web3.js";
import {
  assertProofPacket,
  scoreExecution,
  type ExecutionProofPacket,
} from "../../../packages/core/src/index.js";
import { loadConfig, safeConfigSummary } from "./config.js";
import { createLogger } from "./logger.js";
import { createProoflineStore } from "./storage.js";

interface CheckResult {
  name: string;
  ok: boolean;
  detail?: unknown;
}

async function main(): Promise<void> {
  const config = loadConfig();
  const logger = createLogger(`online_validation_${Date.now()}`);
  const checks: CheckResult[] = [];

  logger.info("Starting online Proofline validation", {
    config: safeConfigSummary(config),
    note: "No x402 payment is sent and no on-chain spend is attempted by this validation script.",
  });

  await runCheck(checks, "unit scoring formulas", testScoring);
  await runCheck(checks, "unit proof packet validation", testProofPacketValidation);
  await runCheck(checks, "runtime storage readiness", async () => {
    const store = createProoflineStore(config);
    await store.ensureReady();
    return { storageMode: store.mode };
  });

  await runCheck(checks, "supabase table counts", () => testSupabaseCounts(config));
  let latestPacket: ExecutionProofPacket | undefined;
  await runCheck(checks, "latest proof packet and signature", async () => {
    latestPacket = await testLatestProof(config);
    return {
      proofPacketId: latestPacket.proofPacketId,
      auditStatus: latestPacket.auditStatus,
      verdict: latestPacket.scores.verdict,
      overallScore: latestPacket.scores.overall,
      packetHash: latestPacket.signature?.packetHash,
      createdAt: latestPacket.createdAt,
    };
  });
  await runCheck(checks, "vercel dashboard routes", () => testVercelRoutes(config));
  await runCheck(checks, "buyer verdict route", () => testBuyerVerdictRoute(config, latestPacket?.proofPacketId));

  const failed = checks.filter((check) => !check.ok);
  logger.info("Online Proofline validation complete", {
    ok: failed.length === 0,
    passed: checks.length - failed.length,
    failed: failed.length,
    checks,
  });

  console.log(JSON.stringify({ ok: failed.length === 0, checks }, null, 2));
  if (failed.length > 0) process.exitCode = 1;
}

async function runCheck<T>(checks: CheckResult[], name: string, fn: () => Promise<T> | T): Promise<T | undefined> {
  try {
    const detail = await fn();
    checks.push({ name, ok: true, detail });
    return detail;
  } catch (error) {
    checks.push({ name, ok: false, detail: error instanceof Error ? error.message : String(error) });
    return undefined;
  }
}

function testScoring(): Record<string, unknown> {
  const delivered = scoreExecution({
    reliability: 100,
    capabilityMatch: 90,
    paymentIntegrity: 100,
    publicFootprint: 80,
    safety: 90,
    riskFlags: [],
  });
  const paymentFailed = scoreExecution({
    reliability: 100,
    capabilityMatch: 100,
    paymentIntegrity: 0,
    publicFootprint: 100,
    safety: 100,
    riskFlags: ["PAYMENT_FAILED"],
  });
  const sentinelWarning = scoreExecution({
    reliability: 100,
    capabilityMatch: 100,
    paymentIntegrity: 100,
    publicFootprint: 100,
    safety: 20,
    riskFlags: ["SENTINEL_WARNING"],
  });

  assert(delivered.verdict === "delivered", "high score should be delivered");
  assert(paymentFailed.verdict === "failed", "PAYMENT_FAILED should force failed verdict");
  assert(sentinelWarning.verdict === "warning", "SENTINEL_WARNING should force warning verdict");
  return { delivered, paymentFailed, sentinelWarning };
}

function testProofPacketValidation(): Record<string, unknown> {
  let invalidRejected = false;
  try {
    assertProofPacket({ proofPacketId: "", targetAgent: {}, auditJob: {} } as ExecutionProofPacket);
  } catch {
    invalidRejected = true;
  }
  assert(invalidRejected, "invalid proof packet should be rejected");
  return { invalidRejected };
}

async function testSupabaseCounts(config: ReturnType<typeof loadConfig>): Promise<Record<string, number>> {
  assert(config.supabaseUrl && config.supabaseServiceRoleKey, "Supabase credentials are required");
  const db = createClient(config.supabaseUrl, config.supabaseServiceRoleKey, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
  const requiredTables = [
    "discovery_runs",
    "sap_targets",
    "audit_jobs",
    "scheduler_runs",
    "payment_receipts",
    "proof_packets",
    "audit_runs",
  ];
  const counts: Record<string, number> = {};
  for (const table of requiredTables) {
    const { count, error } = await db.from(table).select("*", { count: "exact", head: true });
    if (error) throw new Error(`${table}: ${error.message}`);
    counts[table] = count ?? 0;
  }
  assert(tableCount(counts, "discovery_runs") > 0, "discovery_runs must have records");
  assert(tableCount(counts, "sap_targets") > 0, "sap_targets must have records");
  assert(tableCount(counts, "audit_jobs") > 0, "audit_jobs must have records");
  assert(tableCount(counts, "scheduler_runs") > 0, "scheduler_runs must have records");
  assert(tableCount(counts, "proof_packets") > 0, "proof_packets must have records");
  return counts;
}

function tableCount(counts: Record<string, number>, table: string): number {
  return counts[table] ?? 0;
}

async function testLatestProof(config: ReturnType<typeof loadConfig>): Promise<ExecutionProofPacket> {
  const store = createProoflineStore(config);
  const packets = await store.readProofPackets();
  assert(packets.length > 0, "no proof packets found");
  const latest = packets.sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime())[0]!;
  assertProofPacket(latest);
  verifyProofSignature(latest);
  return latest;
}

async function testVercelRoutes(config: ReturnType<typeof loadConfig>): Promise<Record<string, number>> {
  const baseUrl = config.publicBaseUrl.replace(/\/$/, "");
  const routes = ["/x402", "/health", "/commerce", "/proofs"];
  const statuses: Record<string, number> = {};
  for (const route of routes) {
    const response = await fetch(`${baseUrl}${route}`, { signal: AbortSignal.timeout(20000) });
    statuses[route] = response.status;
    assert(response.ok, `${route} returned HTTP ${response.status}`);
  }
  const metadata = await fetchJson(`${baseUrl}/x402`);
  assert(metadata.status === "merchant-ready", "/x402 metadata must be merchant-ready");
  return statuses;
}

async function testBuyerVerdictRoute(config: ReturnType<typeof loadConfig>, proofPacketId: string | undefined): Promise<Record<string, unknown>> {
  assert(proofPacketId, "latest proof packet id is required for buyer verdict test");
  const baseUrl = config.publicBaseUrl.replace(/\/$/, "");
  const url = new URL(`${baseUrl}/x402/get_execution_verdict`);
  url.searchParams.set("proofPacketId", proofPacketId);
  const response = await fetch(url, {
    headers: {
      "x-buyer-wallet": "online_validator",
    },
    signal: AbortSignal.timeout(20000),
  });
  const payload = await readJsonOrText(response);
  assert(response.ok, `buyer verdict route returned HTTP ${response.status}: ${JSON.stringify(payload)}`);
  assert(isRecord(payload) && payload.status === "success", "buyer verdict response must be success");
  assert(isRecord(payload.payment), "buyer verdict response must include payment object");
  return {
    status: response.status,
    sale: isRecord(payload.sale) ? payload.sale : null,
    payment: payload.payment,
  };
}

function verifyProofSignature(packet: ExecutionProofPacket): void {
  assert(packet.signature, "proof packet is unsigned");
  const unsignedPacket: ExecutionProofPacket = { ...packet };
  delete unsignedPacket.signature;
  const signedPayload = stableJson(unsignedPacket);
  const packetHash = createHash("sha256").update(signedPayload).digest("hex");
  assert(packetHash === packet.signature.packetHash, "packet hash mismatch");
  assert(packet.signature.signedPayload === `sha256:${packetHash}`, "signed payload mismatch");

  const publicKeyBytes = new PublicKey(packet.signature.publicKey).toBytes();
  const spkiPrefix = Buffer.from("302a300506032b6570032100", "hex");
  const publicKey = createPublicKey({
    key: Buffer.concat([spkiPrefix, Buffer.from(publicKeyBytes)]),
    format: "der",
    type: "spki",
  });
  const signature = Buffer.from(packet.signature.signatureBase64, "base64");
  const verified = cryptoVerify(null, Buffer.from(signedPayload, "utf8"), publicKey, signature);
  assert(verified, "proof signature verification failed");
}

async function fetchJson(url: string): Promise<Record<string, unknown>> {
  const response = await fetch(url, { signal: AbortSignal.timeout(20000) });
  const payload = await readJsonOrText(response);
  assert(response.ok, `${url} returned HTTP ${response.status}: ${JSON.stringify(payload)}`);
  assert(isRecord(payload), `${url} did not return a JSON object`);
  return payload;
}

async function readJsonOrText(response: Response): Promise<unknown> {
  const text = await response.text();
  if (!text) return null;
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

function stableJson(value: unknown): string {
  return JSON.stringify(sortJson(value));
}

function sortJson(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortJson);
  if (!isRecord(value)) return value;
  return Object.fromEntries(Object.entries(value).sort(([a], [b]) => a.localeCompare(b)).map(([key, item]) => [key, sortJson(item)]));
}

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

main().catch((error: unknown) => {
  console.error(
    JSON.stringify({
      level: "error",
      message: "Online Proofline validation failed",
      error: error instanceof Error ? error.message : String(error),
      timestamp: new Date().toISOString(),
    }),
  );
  process.exitCode = 1;
});
