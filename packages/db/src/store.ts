import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { appendFile, mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import type { AgentTarget, AuditJob, ExecutionProofPacket, PaymentReceipt } from "../../core/src/index.js";

export interface RuntimeStoreConfig {
  mode: "supabase" | "file";
  supabaseUrl?: string;
  supabaseServiceRoleKey?: string;
  filePaths: LocalStorePaths;
}

export interface LocalStorePaths {
  targetsFile: string;
  proofPacketsDir: string;
  artifactsDir: string;
  runsDir: string;
}

export interface DiscoveryPersistenceInput {
  generatedAt: string;
  providerCounts: Record<string, number>;
  providerErrors: Array<{ provider: string; error: string }>;
  totalCandidates: number;
  uniqueTargets: number;
  counts: Record<string, number>;
  targets: unknown[];
  jobs: AuditJob[];
  payload: unknown;
}

export interface SchedulerStatePersistenceInput {
  schedulerRunId: string;
  status: string;
  mode?: string;
  paymentMode?: string;
  currentCycle?: number;
  startedAt?: string;
  updatedAt: string;
  stoppedAt?: string;
  payload: unknown;
}

export interface RuntimeStore {
  mode: "supabase" | "file";
  ensureReady(): Promise<void>;
  readSeedTargets(): Promise<AgentTarget[]>;
  saveDiscovery(input: DiscoveryPersistenceInput): Promise<void>;
  readAuditJobs(): Promise<AuditJob[]>;
  readPaymentReceipts(): Promise<PaymentReceipt[]>;
  readProofPackets(): Promise<ExecutionProofPacket[]>;
  savePaymentReceipt(receipt: PaymentReceipt): Promise<void>;
  saveProofPacket(packet: ExecutionProofPacket): Promise<string>;
  saveAuditRun(runId: string, state: unknown): Promise<string>;
  saveSchedulerState(state: SchedulerStatePersistenceInput): Promise<void>;
}

export function createRuntimeStore(config: RuntimeStoreConfig): RuntimeStore {
  if (config.mode === "supabase") {
    if (!config.supabaseUrl || !config.supabaseServiceRoleKey) {
      throw new Error("Supabase storage requires SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY");
    }
    return new SupabaseRuntimeStore(config.supabaseUrl, config.supabaseServiceRoleKey, config.filePaths);
  }
  return new FileRuntimeStore(config.filePaths);
}

export class FileRuntimeStore implements RuntimeStore {
  readonly mode = "file" as const;

  constructor(private readonly paths: LocalStorePaths) {}

  async ensureReady(): Promise<void> {
    await Promise.all([
      mkdir(this.paths.proofPacketsDir, { recursive: true }),
      mkdir(this.paths.artifactsDir, { recursive: true }),
      mkdir(this.paths.runsDir, { recursive: true }),
      mkdir(dirname(this.paths.targetsFile), { recursive: true }),
    ]);
  }

  async readSeedTargets(): Promise<AgentTarget[]> {
    const filePath = resolve(this.paths.targetsFile);
    const raw = await readFile(filePath, "utf8");
    const parsed: unknown = JSON.parse(raw);

    if (!Array.isArray(parsed)) {
      throw new Error(`Seed targets file must contain an array: ${filePath}`);
    }

    return parsed.map((item, index) => parseTarget(item, index));
  }

  async saveDiscovery(input: DiscoveryPersistenceInput): Promise<void> {
    await Promise.all([
      writeJson("data/sap/discovered-agents.json", {
        generatedAt: input.generatedAt,
        providerCounts: input.providerCounts,
        providerErrors: input.providerErrors,
        totalCandidates: input.totalCandidates,
        uniqueTargets: input.uniqueTargets,
        targets: input.targets,
      }),
      writeJson("data/sap/audit-target-plan.json", input.payload),
      writeJson("data/sap/audit-job-queue.json", {
        generatedAt: input.generatedAt,
        totalJobs: input.jobs.length,
        jobs: input.jobs,
      }),
    ]);
  }

  async readAuditJobs(): Promise<AuditJob[]> {
    try {
      const raw = await readFile(resolve("data/sap/audit-job-queue.json"), "utf8");
      const parsed = JSON.parse(raw) as { jobs?: AuditJob[] };
      return Array.isArray(parsed.jobs) ? parsed.jobs : [];
    } catch {
      return [];
    }
  }

  async readPaymentReceipts(): Promise<PaymentReceipt[]> {
    try {
      const raw = await readFile(resolve("data/payments/receipts.jsonl"), "utf8");
      return raw
        .split(/\r?\n/)
        .filter(Boolean)
        .flatMap((line) => {
          try {
            return [JSON.parse(line) as PaymentReceipt];
          } catch {
            return [];
          }
        });
    } catch {
      return [];
    }
  }

  async readProofPackets(): Promise<ExecutionProofPacket[]> {
    try {
      const files = await readdir(resolve(this.paths.proofPacketsDir));
      const packets: ExecutionProofPacket[] = [];
      for (const file of files) {
        if (!file.startsWith("proof_") || !file.endsWith(".json")) continue;
        try {
          const raw = await readFile(resolve(this.paths.proofPacketsDir, file), "utf8");
          packets.push(JSON.parse(raw) as ExecutionProofPacket);
        } catch {
          continue;
        }
      }
      return packets;
    } catch {
      return [];
    }
  }

  async savePaymentReceipt(receipt: PaymentReceipt): Promise<void> {
    const ledgerPath = resolve("data/payments/receipts.jsonl");
    const perAuditPath = resolve("data/payments/by-audit", `${receipt.auditJobId}.json`);
    await mkdir(dirname(ledgerPath), { recursive: true });
    await mkdir(dirname(perAuditPath), { recursive: true });
    await appendFile(ledgerPath, `${JSON.stringify(receipt)}\n`, "utf8");

    const auditReceipts = await readAuditReceipts(perAuditPath);
    auditReceipts.push(receipt);
    await writeFile(perAuditPath, `${JSON.stringify(auditReceipts, null, 2)}\n`, "utf8");
  }

  async saveProofPacket(packet: ExecutionProofPacket): Promise<string> {
    const filePath = resolve(this.paths.proofPacketsDir, `${packet.proofPacketId}.json`);
    await writeJson(filePath, packet);
    return filePath;
  }

  async saveAuditRun(runId: string, state: unknown): Promise<string> {
    const filePath = resolve(this.paths.runsDir, `${runId}.json`);
    await writeJson(filePath, state);
    return filePath;
  }

  async saveSchedulerState(state: SchedulerStatePersistenceInput): Promise<void> {
    await writeJson("data/automation/scheduler-state.json", state.payload);
    await writeJson("public/automation/health.json", state.payload);
  }
}

class SupabaseRuntimeStore implements RuntimeStore {
  readonly mode = "supabase" as const;
  private readonly client: SupabaseClient;

  constructor(
    supabaseUrl: string,
    supabaseServiceRoleKey: string,
    private readonly filePaths: LocalStorePaths,
  ) {
    this.client = createClient(supabaseUrl, supabaseServiceRoleKey, {
      auth: {
        persistSession: false,
        autoRefreshToken: false,
      },
    });
  }

  async ensureReady(): Promise<void> {
    const { error } = await this.client.from("scheduler_runs").select("scheduler_run_id").limit(1);
    if (error) {
      throw new Error(`Supabase storage is not ready: ${error.message}`);
    }
  }

  async readSeedTargets(): Promise<AgentTarget[]> {
    try {
      const raw = await readFile(resolve(this.filePaths.targetsFile), "utf8");
      const parsed: unknown = JSON.parse(raw);
      return Array.isArray(parsed) ? parsed.map((item, index) => parseTarget(item, index)) : [];
    } catch {
      return [];
    }
  }

  async saveDiscovery(input: DiscoveryPersistenceInput): Promise<void> {
    const targetRows = input.targets
      .map((target) => normalizeDiscoveryTarget(target))
      .filter((target): target is NonNullable<ReturnType<typeof normalizeDiscoveryTarget>> => target !== null);
    const jobRows = input.jobs.map((job) => ({
      audit_job_id: job.auditJobId,
      target_key: targetKey(job.target.agentId, job.target.toolId),
      status: job.status,
      max_spend_usdc: job.maxSpendUsdc,
      created_at: job.createdAt,
      updated_at: new Date().toISOString(),
      payload: job,
    }));

    const { error: runError } = await this.client.from("discovery_runs").insert({
      generated_at: input.generatedAt,
      total_candidates: input.totalCandidates,
      unique_targets: input.uniqueTargets,
      provider_counts: input.providerCounts,
      provider_errors: input.providerErrors,
      counts: input.counts,
      payload: input.payload,
    });
    if (runError) throw new Error(`Failed to save discovery run: ${runError.message}`);

    if (targetRows.length > 0) {
      const { error } = await this.client.from("sap_targets").upsert(targetRows, { onConflict: "target_key" });
      if (error) throw new Error(`Failed to save SAP targets: ${error.message}`);
    }

    if (jobRows.length > 0) {
      const { error } = await this.client.from("audit_jobs").upsert(jobRows, { onConflict: "audit_job_id" });
      if (error) throw new Error(`Failed to save audit jobs: ${error.message}`);
    }
  }

  async readAuditJobs(): Promise<AuditJob[]> {
    const { data, error } = await this.client
      .from("audit_jobs")
      .select("payload")
      .eq("status", "queued")
      .order("created_at", { ascending: true })
      .limit(50);
    if (error) throw new Error(`Failed to read audit jobs: ${error.message}`);
    return (data ?? []).flatMap((row) => (isRecord(row.payload) ? [row.payload as unknown as AuditJob] : []));
  }

  async readPaymentReceipts(): Promise<PaymentReceipt[]> {
    const { data, error } = await this.client
      .from("payment_receipts")
      .select("payload")
      .order("created_at", { ascending: false })
      .limit(500);
    if (error) throw new Error(`Failed to read payment receipts: ${error.message}`);
    return (data ?? []).flatMap((row) => (isRecord(row.payload) ? [row.payload as unknown as PaymentReceipt] : []));
  }

  async readProofPackets(): Promise<ExecutionProofPacket[]> {
    const { data, error } = await this.client
      .from("proof_packets")
      .select("payload")
      .order("created_at", { ascending: false })
      .limit(500);
    if (error) throw new Error(`Failed to read proof packets: ${error.message}`);
    return (data ?? []).flatMap((row) => (isRecord(row.payload) ? [row.payload as unknown as ExecutionProofPacket] : []));
  }

  async savePaymentReceipt(receipt: PaymentReceipt): Promise<void> {
    const { error } = await this.client.from("payment_receipts").upsert(
      {
        payment_id: receipt.paymentId,
        audit_job_id: receipt.auditJobId,
        provider: receipt.provider,
        method: receipt.method,
        amount: receipt.amount,
        currency: receipt.currency,
        recipient: receipt.recipient ?? null,
        service: receipt.service,
        status: receipt.status,
        transaction_hash: receipt.transactionHash ?? null,
        created_at: receipt.createdAt,
        confirmed_at: receipt.confirmedAt ?? null,
        payload: receipt,
      },
      { onConflict: "payment_id" },
    );
    if (error) throw new Error(`Failed to save payment receipt: ${error.message}`);
  }

  async saveProofPacket(packet: ExecutionProofPacket): Promise<string> {
    const { error } = await this.client.from("proof_packets").upsert(
      {
        proof_packet_id: packet.proofPacketId,
        audit_job_id: packet.auditJob.auditJobId,
        target_agent_id: packet.targetAgent.agentId,
        target_tool_id: packet.targetAgent.toolId,
        audit_status: packet.auditStatus,
        verdict: packet.scores.verdict,
        overall_score: packet.scores.overall,
        risk_flags: packet.riskFlags,
        proof_card_url: packet.artifacts.proofCardPath ?? null,
        packet_hash: packet.signature?.packetHash ?? null,
        created_at: packet.createdAt,
        payload: packet,
      },
      { onConflict: "proof_packet_id" },
    );
    if (error) throw new Error(`Failed to save proof packet: ${error.message}`);
    return `supabase:proof_packets/${packet.proofPacketId}`;
  }

  async saveAuditRun(runId: string, state: unknown): Promise<string> {
    const payload = isRecord(state) ? state : { value: state };
    const { error } = await this.client.from("audit_runs").upsert(
      {
        audit_job_id: runId,
        proof_packet_id: stringOrNull(payload.proofPacketId),
        audit_status: stringOrNull(payload.auditStatus),
        target_agent_id: isRecord(payload.target) ? stringOrNull(payload.target.agentId) : null,
        target_name: isRecord(payload.target) ? stringOrNull(payload.target.name) : null,
        verdict: stringOrNull(payload.verdict),
        overall_score: numberOrNull(payload.overallScore),
        started_at: null,
        completed_at: stringOrNull(payload.completedAt),
        updated_at: new Date().toISOString(),
        payload,
      },
      { onConflict: "audit_job_id" },
    );
    if (error) throw new Error(`Failed to save audit run: ${error.message}`);
    return `supabase:audit_runs/${runId}`;
  }

  async saveSchedulerState(state: SchedulerStatePersistenceInput): Promise<void> {
    const { error } = await this.client.from("scheduler_runs").upsert(
      {
        scheduler_run_id: state.schedulerRunId,
        status: state.status,
        mode: state.mode ?? null,
        payment_mode: state.paymentMode ?? null,
        current_cycle: state.currentCycle ?? 0,
        started_at: state.startedAt ?? null,
        updated_at: state.updatedAt,
        stopped_at: state.stoppedAt ?? null,
        payload: state.payload,
      },
      { onConflict: "scheduler_run_id" },
    );
    if (error) throw new Error(`Failed to save scheduler state: ${error.message}`);
  }
}

async function writeJson(filePath: string, value: unknown): Promise<void> {
  await mkdir(dirname(resolve(filePath)), { recursive: true });
  await writeFile(resolve(filePath), `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

async function readAuditReceipts(path: string): Promise<PaymentReceipt[]> {
  try {
    const raw = await readFile(path, "utf8");
    const parsed: unknown = JSON.parse(raw);
    return Array.isArray(parsed) ? (parsed as PaymentReceipt[]) : [];
  } catch {
    return [];
  }
}

function normalizeDiscoveryTarget(value: unknown):
  | {
      target_key: string;
      agent_id: string;
      tool_id: string;
      name: string;
      status: string | null;
      priority_score: number | null;
      payment_method: string | null;
      currency: string | null;
      endpoint: string | null;
      source: string | null;
      discovered_at: string;
      updated_at: string;
      payload: unknown;
    }
  | null {
  if (!isRecord(value)) return null;
  const agentId = stringOrNull(value.agentId);
  const toolId = stringOrNull(value.toolId);
  const name = stringOrNull(value.name);
  if (!agentId || !toolId || !name) return null;

  const now = new Date().toISOString();
  return {
    target_key: targetKey(agentId, toolId),
    agent_id: agentId,
    tool_id: toolId,
    name,
    status: stringOrNull(value.status),
    priority_score: numberOrNull(value.priorityScore),
    payment_method: stringOrNull(value.paymentMethod),
    currency: stringOrNull(value.token ?? value.currency),
    endpoint: stringOrNull(value.endpoint),
    source: stringOrNull(value.source),
    discovered_at: now,
    updated_at: now,
    payload: value,
  };
}

function parseTarget(value: unknown, index: number): AgentTarget {
  if (!isRecord(value)) {
    throw new Error(`Seed target at index ${index} must be an object`);
  }

  return {
    agentId: requiredString(value, "agentId", index),
    name: requiredString(value, "name", index),
    toolId: requiredString(value, "toolId", index),
    toolName: requiredString(value, "toolName", index),
    description: requiredString(value, "description", index),
    category: requiredString(value, "category", index),
    price: requiredString(value, "price", index),
    currency: requiredString(value, "currency", index),
    paymentMethod: parsePaymentMethod(requiredString(value, "paymentMethod", index)),
    endpoint: requiredString(value, "endpoint", index),
    source: parseSource(requiredString(value, "source", index)),
  };
}

function requiredString(record: Record<string, unknown>, key: string, index: number): string {
  const value = record[key];

  if (typeof value !== "string" || value.length === 0) {
    throw new Error(`Seed target at index ${index} is missing string field "${key}"`);
  }

  return value;
}

function parsePaymentMethod(value: string): AgentTarget["paymentMethod"] {
  if (value === "x402" || value === "sap_escrow" || value === "manual_seed" || value === "unknown") {
    return value;
  }

  return "unknown";
}

function parseSource(value: string): AgentTarget["source"] {
  if (value === "manual_seed" || value === "sap_discovery") {
    return value;
  }

  throw new Error(`Unsupported target source: ${value}`);
}

function targetKey(agentId: string, toolId: string): string {
  return `${agentId}::${toolId}`;
}

function stringOrNull(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

function numberOrNull(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
