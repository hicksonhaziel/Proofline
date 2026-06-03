import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import type { AuditJob, PaymentReceipt } from "../../../packages/core/src/index.js";
import type { RuntimeStore } from "../../../packages/db/src/index.js";
import type { ProoflineConfig } from "./config.js";
import { createLogger, type Logger } from "./logger.js";
import { createProoflineStore } from "./storage.js";

type SchedulerMode = "demo" | "production";
type SchedulerStatus = "idle" | "running" | "stopping" | "stopped" | "failed";
type SchedulerDecisionStatus = "selected" | "skipped" | "failed";

interface SchedulerOptions {
  once: boolean;
  discover: boolean;
  allowPaid: boolean;
  useAce: boolean;
  maxJobsPerCycle: number;
  maxCycles: number | null;
  mode: SchedulerMode;
}

interface QueuePayload {
  generatedAt?: string;
  totalJobs?: number;
  jobs?: AuditJob[];
}

interface SchedulerDecision {
  targetName?: string;
  targetAgentId?: string;
  status: SchedulerDecisionStatus;
  reason: string;
  auditJobId?: string;
}

interface SchedulerState {
  schedulerRunId: string;
  status: SchedulerStatus;
  mode: SchedulerMode;
  startedAt: string;
  updatedAt: string;
  stoppedAt?: string;
  currentCycle: number;
  intervalMinutes: number;
  queuePath: string;
  maxJobsPerCycle: number;
  allowPaid: boolean;
  paymentMode: string;
  budgets: {
    maxSpendPerAuditUsdc: number;
    maxSpendPerHourUsdc: number;
    maxSpendPerDayUsdc: number;
    spentLastHourUsdc: number;
    spentLastDayUsdc: number;
  };
  retryPolicy: {
    maxFailedPaymentRetries: number;
    failedPaymentRetryWindowHours: number;
  };
  queue: {
    total: number;
    eligible: number;
    skipped: number;
  };
  lastDiscovery?: {
    ok: boolean;
    completedAt: string;
    error?: string;
  };
  lastAudit?: {
    ok: boolean;
    targetName?: string;
    completedAt: string;
    error?: string;
  };
  decisions: SchedulerDecision[];
  shutdownReason?: string;
}

const QUEUE_PATH = "supabase:audit_jobs";
const DEFAULT_DEMO_INTERVAL_MINUTES = 15;
const DEFAULT_PRODUCTION_INTERVAL_MINUTES = 30;
const MAX_FAILED_PAYMENT_RETRIES = 1;
const FAILED_PAYMENT_RETRY_WINDOW_HOURS = 24;

export async function runScheduler(config: ProoflineConfig, options: SchedulerOptions): Promise<void> {
  const schedulerRunId = `scheduler_${randomUUID()}`;
  const logger = createLogger(schedulerRunId);
  const store = createProoflineStore(config);
  await store.ensureReady();
  let stopping = false;
  let state = initialState(schedulerRunId, config, options);

  const requestStop = async (reason: string): Promise<void> => {
    if (stopping) return;
    stopping = true;
    state = {
      ...state,
      status: "stopping",
      shutdownReason: reason,
      updatedAt: new Date().toISOString(),
    };
    await writeSchedulerState(store, state);
    logger.warn("Scheduler stop requested", { reason });
  };

  process.once("SIGINT", () => void requestStop("SIGINT"));
  process.once("SIGTERM", () => void requestStop("SIGTERM"));

  logger.info("Proofline automation scheduler starting", {
    mode: options.mode,
    once: options.once,
    discover: options.discover,
    allowPaid: options.allowPaid,
    useAce: options.useAce,
    maxJobsPerCycle: options.maxJobsPerCycle,
    paymentMode: paymentMode(),
    note: "Scheduler defaults to dry-run payments unless PAYMENT_MODE=send and PAYMENT_CONFIRM_SPEND=true are set.",
  });
  await writeSchedulerState(store, state);

  try {
    do {
      state = await runCycle(state, config, options, logger, store);
      if (options.once) break;
      if (options.maxCycles !== null && state.currentCycle >= options.maxCycles) break;
      if (stopping) break;
      await sleep(intervalMs(state.intervalMinutes), () => stopping);
    } while (!stopping);

    state = {
      ...state,
      status: stopping ? "stopped" : "idle",
      stoppedAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      shutdownReason: state.shutdownReason ?? (options.once ? "once_completed" : "max_cycles_completed"),
    };
    await writeSchedulerState(store, state);
    logger.info("Proofline automation scheduler stopped", {
      currentCycle: state.currentCycle,
      shutdownReason: state.shutdownReason,
    });
  } catch (error) {
    state = {
      ...state,
      status: "failed",
      stoppedAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      shutdownReason: error instanceof Error ? error.message : String(error),
    };
    await writeSchedulerState(store, state);
    logger.error("Proofline automation scheduler failed", { error: state.shutdownReason });
    throw error;
  }
}

export function parseSchedulerArgs(argv: string[]): SchedulerOptions {
  const mode = valueArg(argv, "--scheduler-mode") === "production" ? "production" : "demo";
  const once = argv.includes("--once");
  const discover = !argv.includes("--no-discover");
  const allowPaid = !argv.includes("--no-paid");
  const useAce = !argv.includes("--no-ace");
  const maxJobsPerCycle = positiveIntArg(argv, "--max-jobs", 1);
  const maxCycles = once ? 1 : nullablePositiveIntArg(argv, "--max-cycles");

  return {
    once,
    discover,
    allowPaid,
    useAce,
    maxJobsPerCycle,
    maxCycles,
    mode,
  };
}

async function runCycle(
  state: SchedulerState,
  config: ProoflineConfig,
  options: SchedulerOptions,
  logger: Logger,
  store: RuntimeStore,
): Promise<SchedulerState> {
  const cycle = state.currentCycle + 1;
  let nextState: SchedulerState = {
    ...state,
    status: "running",
    currentCycle: cycle,
    updatedAt: new Date().toISOString(),
    decisions: [],
  };
  await writeSchedulerState(store, nextState);
  logger.info("Scheduler cycle starting", { cycle });

  if (options.discover) {
    const discovery = await runCommand("npm", ["run", "sap:discover"], schedulerEnv(), logger);
    nextState = {
      ...nextState,
      lastDiscovery: {
        ok: discovery.ok,
        completedAt: new Date().toISOString(),
        ...(discovery.ok ? {} : { error: discovery.error ?? `exit ${discovery.exitCode}` }),
      },
      updatedAt: new Date().toISOString(),
    };
    await writeSchedulerState(store, nextState);
  }

  const jobs = await store.readAuditJobs();
  const queue: QueuePayload = { jobs, totalJobs: jobs.length };
  const receipts = await store.readPaymentReceipts();
  const spend = summarizeSpend(receipts);
  const auditedTargets = await recentlyAuditedTargets(store, config.limits.minReauditIntervalHours);
  const selected = selectJobs(queue.jobs ?? [], receipts, config, options, spend, auditedTargets);
  const decisions = [...selected.decisions];

  nextState = {
    ...nextState,
    budgets: {
      ...nextState.budgets,
      spentLastHourUsdc: spend.lastHourUsdc,
      spentLastDayUsdc: spend.lastDayUsdc,
    },
    queue: {
      total: queue.jobs?.length ?? 0,
      eligible: selected.jobs.length,
      skipped: decisions.filter((item) => item.status === "skipped").length,
    },
    decisions,
    updatedAt: new Date().toISOString(),
  };
  await writeSchedulerState(store, nextState);

  for (const job of selected.jobs) {
    const targetName = job.target.name;
    logger.info("Scheduler selected audit job", {
      auditJobId: job.auditJobId,
      targetName,
      targetAgentId: job.target.agentId,
      paymentMethod: job.target.paymentMethod,
      price: job.target.price,
    });

    const auditArgs = ["run", "audit:once", "--", "--target", targetName];
    if (options.allowPaid) auditArgs.push("--allow-paid");
    if (!options.useAce) auditArgs.push("--no-ace");

    const audit = await runCommand("npm", auditArgs, schedulerEnv(), logger);
    const completedAt = new Date().toISOString();
    decisions.push({
      targetName,
      targetAgentId: job.target.agentId,
      status: audit.ok ? "selected" : "failed",
      reason: audit.ok ? "audit command completed" : audit.error ?? `audit exited ${audit.exitCode}`,
      auditJobId: job.auditJobId,
    });
    nextState = {
      ...nextState,
      lastAudit: {
        ok: audit.ok,
        targetName,
        completedAt,
        ...(audit.ok ? {} : { error: audit.error ?? `exit ${audit.exitCode}` }),
      },
      decisions,
      updatedAt: completedAt,
    };
    await writeSchedulerState(store, nextState);
  }

  logger.info("Scheduler cycle complete", {
    cycle,
    totalJobs: queue.jobs?.length ?? 0,
    selectedJobs: selected.jobs.length,
    skippedJobs: nextState.queue.skipped,
    spentLastHourUsdc: nextState.budgets.spentLastHourUsdc,
    spentLastDayUsdc: nextState.budgets.spentLastDayUsdc,
  });

  return {
    ...nextState,
    status: "idle",
    updatedAt: new Date().toISOString(),
  };
}

function selectJobs(
  jobs: AuditJob[],
  receipts: PaymentReceipt[],
  config: ProoflineConfig,
  options: SchedulerOptions,
  spend: { lastHourUsdc: number; lastDayUsdc: number },
  auditedTargets: Set<string>,
): { jobs: AuditJob[]; decisions: SchedulerDecision[] } {
  const selected: AuditJob[] = [];
  const decisions: SchedulerDecision[] = [];

  for (const job of jobs) {
    const targetKey = `${job.target.agentId}::${job.target.toolId}`;
    const targetName = job.target.name;
    const amountUsdc = estimateJobCostUsdc(job);

    if (selected.length >= options.maxJobsPerCycle) {
      decisions.push({ targetName, targetAgentId: job.target.agentId, status: "skipped", reason: "max jobs per cycle reached", auditJobId: job.auditJobId });
      continue;
    }

    if (auditedTargets.has(targetKey)) {
      decisions.push({ targetName, targetAgentId: job.target.agentId, status: "skipped", reason: "target audited inside configured re-audit window", auditJobId: job.auditJobId });
      continue;
    }

    if (job.target.paymentMethod === "sap_escrow" && job.target.currency !== "SOL") {
      decisions.push({ targetName, targetAgentId: job.target.agentId, status: "skipped", reason: "SAP escrow automation currently supports SOL targets only", auditJobId: job.auditJobId });
      continue;
    }

    if (paymentMode() === "send" && job.target.paymentMethod === "x402" && !isAceDataCloudTarget(job)) {
      decisions.push({ targetName, targetAgentId: job.target.agentId, status: "skipped", reason: "generic non-Ace x402 send mode is not implemented", auditJobId: job.auditJobId });
      continue;
    }

    if (job.target.agentId === "GGN3y79CAejSM1xhNgBdQNatKQv7WegJBvo5aaAYYKzL") {
      decisions.push({ targetName, targetAgentId: job.target.agentId, status: "skipped", reason: "scheduler will not audit Proofline itself", auditJobId: job.auditJobId });
      continue;
    }

    if (paymentMode() === "send") {
      const maxAfterHour = spend.lastHourUsdc + amountUsdc;
      const maxAfterDay = spend.lastDayUsdc + amountUsdc;
      if (amountUsdc > config.limits.maxSpendPerAuditUsdc) {
        decisions.push({ targetName, targetAgentId: job.target.agentId, status: "skipped", reason: "estimated job cost exceeds per-audit budget", auditJobId: job.auditJobId });
        continue;
      }
      if (maxAfterHour > config.limits.maxSpendPerHourUsdc) {
        decisions.push({ targetName, targetAgentId: job.target.agentId, status: "skipped", reason: "hourly spend budget would be exceeded", auditJobId: job.auditJobId });
        continue;
      }
      if (maxAfterDay > config.limits.maxSpendPerDayUsdc) {
        decisions.push({ targetName, targetAgentId: job.target.agentId, status: "skipped", reason: "daily spend budget would be exceeded", auditJobId: job.auditJobId });
        continue;
      }
    }

    if (failedPaymentAttempts(job, receipts) >= MAX_FAILED_PAYMENT_RETRIES) {
      decisions.push({ targetName, targetAgentId: job.target.agentId, status: "skipped", reason: "failed payment retry cap reached for this target", auditJobId: job.auditJobId });
      continue;
    }

    selected.push(job);
    decisions.push({ targetName, targetAgentId: job.target.agentId, status: "selected", reason: "eligible for autonomous audit", auditJobId: job.auditJobId });
  }

  return { jobs: selected, decisions };
}

function initialState(schedulerRunId: string, config: ProoflineConfig, options: SchedulerOptions): SchedulerState {
  const intervalMinutes =
    options.mode === "demo"
      ? Math.max(1, Number(process.env.SCHEDULER_INTERVAL_MINUTES ?? DEFAULT_DEMO_INTERVAL_MINUTES))
      : Math.max(1, Number(process.env.SCHEDULER_INTERVAL_MINUTES ?? config.auditIntervalMinutes ?? DEFAULT_PRODUCTION_INTERVAL_MINUTES));

  return {
    schedulerRunId,
    status: "idle",
    mode: options.mode,
    startedAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    currentCycle: 0,
    intervalMinutes,
    queuePath: QUEUE_PATH,
    maxJobsPerCycle: options.maxJobsPerCycle,
    allowPaid: options.allowPaid,
    paymentMode: paymentMode(),
    budgets: {
      maxSpendPerAuditUsdc: config.limits.maxSpendPerAuditUsdc,
      maxSpendPerHourUsdc: config.limits.maxSpendPerHourUsdc,
      maxSpendPerDayUsdc: config.limits.maxSpendPerDayUsdc,
      spentLastHourUsdc: 0,
      spentLastDayUsdc: 0,
    },
    retryPolicy: {
      maxFailedPaymentRetries: MAX_FAILED_PAYMENT_RETRIES,
      failedPaymentRetryWindowHours: FAILED_PAYMENT_RETRY_WINDOW_HOURS,
    },
    queue: {
      total: 0,
      eligible: 0,
      skipped: 0,
    },
    decisions: [],
  };
}

async function writeSchedulerState(store: RuntimeStore, state: SchedulerState): Promise<void> {
  const health = {
    schedulerRunId: state.schedulerRunId,
    status: state.status,
    mode: state.mode,
    updatedAt: state.updatedAt,
    startedAt: state.startedAt,
    stoppedAt: state.stoppedAt,
    currentCycle: state.currentCycle,
    intervalMinutes: state.intervalMinutes,
    queue: state.queue,
    budgets: state.budgets,
    retryPolicy: state.retryPolicy,
    lastDiscovery: state.lastDiscovery,
    lastAudit: state.lastAudit,
    decisions: state.decisions.slice(-12),
    shutdownReason: state.shutdownReason,
    paymentMode: state.paymentMode,
    allowPaid: state.allowPaid,
  };
  await store.saveSchedulerState({
    schedulerRunId: state.schedulerRunId,
    status: state.status,
    mode: state.mode,
    paymentMode: state.paymentMode,
    currentCycle: state.currentCycle,
    startedAt: state.startedAt,
    updatedAt: state.updatedAt,
    ...(state.stoppedAt ? { stoppedAt: state.stoppedAt } : {}),
    payload: health,
  });
}

function summarizeSpend(receipts: PaymentReceipt[]): { lastHourUsdc: number; lastDayUsdc: number } {
  const now = Date.now();
  const hourAgo = now - 60 * 60 * 1000;
  const dayAgo = now - 24 * 60 * 60 * 1000;
  let lastHourUsdc = 0;
  let lastDayUsdc = 0;

  for (const receipt of receipts) {
    if (receipt.status !== "settled" && !(paymentMode() === "send" && receipt.status === "pending")) continue;
    if (receipt.currency !== "USDC") continue;
    const createdAt = receipt.createdAt ? new Date(receipt.createdAt).getTime() : NaN;
    if (!Number.isFinite(createdAt)) continue;
    const amount = Number(receipt.amount);
    if (!Number.isFinite(amount)) continue;
    if (createdAt >= hourAgo) lastHourUsdc += amount;
    if (createdAt >= dayAgo) lastDayUsdc += amount;
  }

  return { lastHourUsdc, lastDayUsdc };
}

async function recentlyAuditedTargets(store: RuntimeStore, minReauditIntervalHours: number): Promise<Set<string>> {
  const out = new Set<string>();
  const cutoff = Date.now() - minReauditIntervalHours * 60 * 60 * 1000;
  const packets = await store.readProofPackets();
  for (const packet of packets) {
    const createdAt = new Date(packet.createdAt).getTime();
    if (!Number.isFinite(createdAt) || createdAt < cutoff) continue;
    out.add(`${packet.targetAgent.agentId}::${packet.targetAgent.toolId}`);
  }
  return out;
}

function failedPaymentAttempts(job: AuditJob, receipts: PaymentReceipt[]): number {
  const cutoff = Date.now() - FAILED_PAYMENT_RETRY_WINDOW_HOURS * 60 * 60 * 1000;
  return receipts.filter((receipt) => {
    if (receipt.status !== "failed") return false;
    if (receipt.service !== job.target.name) return false;
    const createdAt = receipt.createdAt ? new Date(receipt.createdAt).getTime() : NaN;
    return Number.isFinite(createdAt) && createdAt >= cutoff;
  }).length;
}

function estimateJobCostUsdc(job: AuditJob): number {
  if (job.target.currency === "USDC") {
    const amount = Number(job.target.price.split(" ")[0]);
    return Number.isFinite(amount) ? amount : 0;
  }
  return 0;
}

function isAceDataCloudTarget(job: AuditJob): boolean {
  try {
    return new URL(job.target.endpoint).hostname === "api.acedata.cloud";
  } catch {
    return false;
  }
}

async function runCommand(
  cmd: string,
  args: string[],
  env: NodeJS.ProcessEnv,
  logger: Logger,
): Promise<{ ok: boolean; exitCode: number | null; error?: string }> {
  logger.info("Running scheduler command", { cmd, args });
  return await new Promise((resolveCommand) => {
    const child = spawn(cmd, args, {
      cwd: process.cwd(),
      env,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stderr = "";

    child.stdout.on("data", (chunk: Buffer) => {
      process.stdout.write(chunk);
    });
    child.stderr.on("data", (chunk: Buffer) => {
      stderr += chunk.toString("utf8");
      process.stderr.write(chunk);
    });
    child.on("error", (error) => {
      resolveCommand({ ok: false, exitCode: null, error: error.message });
    });
    child.on("close", (code) => {
      resolveCommand({
        ok: code === 0,
        exitCode: code,
        ...(code === 0 ? {} : { error: stderr.trim().slice(-1000) }),
      });
    });
  });
}

function schedulerEnv(): NodeJS.ProcessEnv {
  return {
    ...process.env,
    PAYMENT_MODE: process.env.PAYMENT_MODE ?? "dry-run",
    PAYMENT_CONFIRM_SPEND: process.env.PAYMENT_CONFIRM_SPEND ?? "false",
  };
}

function paymentMode(): string {
  return process.env.PAYMENT_MODE ?? "dry-run";
}

function intervalMs(minutes: number): number {
  return minutes * 60 * 1000;
}

async function sleep(ms: number, shouldStop: () => boolean): Promise<void> {
  const step = 1000;
  let elapsed = 0;
  while (elapsed < ms && !shouldStop()) {
    await new Promise((resolveSleep) => setTimeout(resolveSleep, Math.min(step, ms - elapsed)));
    elapsed += step;
  }
}

function valueArg(argv: string[], name: string): string | undefined {
  const index = argv.indexOf(name);
  const value = index >= 0 ? argv[index + 1] : undefined;
  return value && !value.startsWith("--") ? value : undefined;
}

function positiveIntArg(argv: string[], name: string, fallback: number): number {
  const value = valueArg(argv, name);
  const parsed = value ? Number(value) : fallback;
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : fallback;
}

function nullablePositiveIntArg(argv: string[], name: string): number | null {
  const value = valueArg(argv, name);
  if (!value) return null;
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : null;
}
