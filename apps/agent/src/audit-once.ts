import { randomUUID } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import {
  assertProofPacket,
  createProofPacketId,
  scoreExecution,
  type AceAnalysisResult,
  type AgentTarget,
  type ExecutionProofPacket,
  type PaymentMethod,
  type PaymentReceipt,
  type ProbeResult,
  type RiskFlag,
  type SentinelCheck,
} from "../../../packages/core/src/index.js";
import { LocalStore } from "../../../packages/db/src/index.js";
import { loadConfig, safeConfigSummary } from "./config.js";
import { createLogger } from "./logger.js";

interface AuditTargetPlan {
  generatedAt?: string;
  recommendedTargets?: PlannedTarget[];
  allTargets?: PlannedTarget[];
}

interface PlannedTarget {
  name: string;
  pda: string;
  wallet: string | null;
  endpoint: string | null;
  agentUri: string | null;
  protocolIds: string[];
  capabilitiesCount: number;
  pricingTier: string | null;
  route: "x402" | "sap_escrow" | "instant" | "batched" | "unknown";
  token: string;
  pricePerCall: string | null;
  pricePerCallDisplay: string | null;
  status: "good_audit_target" | "free" | string;
  reasons: string[];
}

interface CliArgs {
  target?: string | undefined;
  allowPaid: boolean;
  useAce: boolean;
}

interface HttpObservation {
  url: string;
  method: "GET" | "HEAD";
  ok: boolean;
  status: number | null;
  statusText: string | null;
  contentType: string | null;
  bodyPreview?: unknown;
  latencyMs: number;
  error?: string;
}

interface AceVerdict {
  outputQualityScore: number;
  capabilityMatchScore: number;
  summary: string;
  riskFlags: RiskFlag[];
}

const PLAN_PATH = "data/sap/audit-target-plan.json";
const MAX_PREVIEW_CHARS = 6000;
const ACE_CHAT_MODEL = process.env.ACE_CHAT_MODEL ?? "gpt-4o-mini";

async function main(): Promise<void> {
  const args = parseArgs(process.argv);
  const auditJobId = `audit_${randomUUID()}`;
  const logger = createLogger(auditJobId);
  const config = loadConfig();

  logger.info("Starting one-shot Proofline audit", {
    args,
    config: safeConfigSummary(config),
    paymentPolicy: args.allowPaid ? "paid routes may be attempted only if supported" : "no paid calls will be attempted",
  });

  const store = new LocalStore({
    targetsFile: config.targetAgentList,
    proofPacketsDir: "data/proof-packets",
    artifactsDir: "data/artifacts",
    runsDir: "data/runs",
  });
  await store.ensureDirectories();

  const plannedTarget = await selectTarget(args.target);
  const target = toAgentTarget(plannedTarget);
  const startedAt = new Date().toISOString();

  logger.info("Selected audit target", {
    name: target.name,
    agentId: target.agentId,
    endpoint: target.endpoint,
    price: target.price,
    currency: target.currency,
    route: plannedTarget.route,
    status: plannedTarget.status,
  });

  const sentinelCheck = await runPreflight(plannedTarget, config.sentinelAgentId);
  const payment = buildPaymentReceipt(auditJobId, plannedTarget, args.allowPaid);
  const probeResult = await runProbe(auditJobId, target, plannedTarget, payment);
  const aceAnalysis = args.useAce
    ? await runAceAnalysis(auditJobId, target, plannedTarget, sentinelCheck, payment, probeResult, config.aceApiKey)
    : buildSkippedAceAnalysis(auditJobId);

  const riskFlags = mergeRiskFlags(sentinelCheck, payment, probeResult, aceAnalysis);
  const scores = scoreExecution({
    reliability: reliabilityScore(probeResult),
    capabilityMatch: aceAnalysis.capabilityMatchScore ?? heuristicCapabilityScore(probeResult),
    paymentIntegrity: paymentIntegrityScore(payment),
    publicFootprint: publicFootprintScore(plannedTarget),
    safety: safetyScore(sentinelCheck),
    riskFlags,
  });
  const completedAt = new Date().toISOString();

  const packetWithoutId = {
    version: "0.1" as const,
    targetAgent: target,
    auditJob: {
      auditJobId,
      target,
      status: "completed" as const,
      createdAt: startedAt,
      startedAt,
      completedAt,
      maxSpendUsdc: config.limits.maxSpendPerAuditUsdc,
    },
    sentinelCheck,
    payments: [payment],
    probeResult,
    aceAnalysis,
    scores,
    riskFlags,
    artifacts: {},
    createdAt: completedAt,
    auditorAgent: {
      name: "Proofline" as const,
      sapAgentId: "GGN3y79CAejSM1xhNgBdQNatKQv7WegJBvo5aaAYYKzL",
    },
  };

  const packet: ExecutionProofPacket = {
    proofPacketId: createProofPacketId(packetWithoutId),
    ...packetWithoutId,
  };
  assertProofPacket(packet);

  const proofPacketPath = await store.writeProofPacket(packet);
  const runStatePath = await store.writeRunState(auditJobId, {
    auditJobId,
    proofPacketId: packet.proofPacketId,
    target: {
      name: target.name,
      agentId: target.agentId,
      endpoint: target.endpoint,
    },
    payment: {
      status: payment.status,
      amount: payment.amount,
      currency: payment.currency,
      method: payment.method,
      note: "No on-chain payment was made unless status is settled and transactionHash is present.",
    },
    verdict: packet.scores.verdict,
    overallScore: packet.scores.overall,
    proofPacketPath,
    completedAt,
  });

  logger.info("Proofline audit complete", {
    proofPacketId: packet.proofPacketId,
    verdict: packet.scores.verdict,
    overallScore: packet.scores.overall,
    riskFlags,
    paymentStatus: payment.status,
    proofPacketPath,
    runStatePath,
  });
}

function parseArgs(argv: string[]): CliArgs {
  const targetIndex = argv.findIndex((arg) => arg === "--target");
  const target = targetIndex >= 0 ? argv[targetIndex + 1] : undefined;

  return {
    target: target && !target.startsWith("--") ? target : undefined,
    allowPaid: argv.includes("--allow-paid"),
    useAce: !argv.includes("--no-ace"),
  };
}

async function selectTarget(targetQuery: string | undefined): Promise<PlannedTarget> {
  const raw = await readFile(resolve(PLAN_PATH), "utf8");
  const plan = JSON.parse(raw) as AuditTargetPlan;
  const targets = [...(plan.recommendedTargets ?? []), ...(plan.allTargets ?? [])].filter(isUsableTarget);

  if (targets.length === 0) {
    throw new Error(`No usable targets found in ${PLAN_PATH}. Run npm run sap:discover first.`);
  }

  if (targetQuery) {
    const normalized = targetQuery.toLowerCase();
    const match = targets.find(
      (target) =>
        target.name.toLowerCase() === normalized ||
        target.name.toLowerCase().includes(normalized) ||
        target.pda === targetQuery,
    );

    if (!match) {
      throw new Error(`No recommended target matched "${targetQuery}" in ${PLAN_PATH}`);
    }

    return match;
  }

  return targets.find((target) => target.status === "free") ?? targets[0]!;
}

function isUsableTarget(target: PlannedTarget): boolean {
  return (
    (target.status === "good_audit_target" || target.status === "free") &&
    typeof target.endpoint === "string" &&
    target.endpoint.length > 0 &&
    !target.endpoint.includes("/:") &&
    !target.endpoint.includes(":name")
  );
}

function toAgentTarget(target: PlannedTarget): AgentTarget {
  return {
    agentId: target.pda,
    name: target.name,
    toolId: target.pricingTier ?? target.pda,
    toolName: target.pricingTier ?? "default",
    description: target.reasons.join("; "),
    category: "sap_agent",
    price: target.pricePerCallDisplay ?? "unknown",
    currency: target.token,
    paymentMethod: target.route === "sap_escrow" ? "sap_escrow" : target.route === "x402" ? "x402" : "unknown",
    endpoint: target.endpoint ?? "",
    source: "sap_discovery",
  };
}

async function runPreflight(target: PlannedTarget, sentinelAgentId: string): Promise<SentinelCheck> {
  const checkedAt = new Date().toISOString();
  const endpointHead = target.endpoint ? await observeUrl(target.endpoint, "HEAD") : null;
  const endpointGet = shouldFollowUpWithGet(endpointHead) && target.endpoint ? await observeUrl(target.endpoint, "GET") : null;
  const agentUriGet = target.agentUri ? await observeUrl(target.agentUri, "GET") : null;
  const observations = [endpointHead, endpointGet, agentUriGet].filter((item): item is HttpObservation => item !== null);
  const hasReachableEndpoint = observations.some((item) => item.url === target.endpoint && isReachableStatus(item.status));
  const hasAnyReachableUrl = observations.some((item) => isReachableStatus(item.status));

  if (hasReachableEndpoint) {
    return {
      status: "healthy",
      sentinelAgentId,
      checkedAt,
      raw: {
        mode: "local_preflight",
        note: "No paid Sentinel call was made in this low-spend runner.",
        observations,
      },
      message: "Target endpoint responded during local preflight.",
    };
  }

  if (hasAnyReachableUrl) {
    return {
      status: "warning",
      sentinelAgentId,
      checkedAt,
      raw: {
        mode: "local_preflight",
        note: "Agent metadata responded, but the execution endpoint did not clearly respond.",
        observations,
      },
      message: "Target has a public footprint, but endpoint health is uncertain.",
    };
  }

  return {
    status: "failed",
    sentinelAgentId,
    checkedAt,
    raw: {
      mode: "local_preflight",
      observations,
    },
    message: "Target endpoint and metadata were not reachable during preflight.",
  };
}

function buildPaymentReceipt(auditJobId: string, target: PlannedTarget, allowPaid: boolean): PaymentReceipt {
  const isFree = target.status === "free" || target.pricePerCall === "0";
  const amount = target.pricePerCallDisplay?.split(" ")[0] ?? "0";
  const currency = target.token === "unknown" ? "unknown" : target.token;
  const method: PaymentMethod = target.route === "sap_escrow" ? "sap_escrow" : target.route === "x402" ? "x402" : "unknown";
  const baseReceipt = {
    paymentId: `pay_${randomUUID()}`,
    auditJobId,
    provider: "sap" as const,
    method,
    amount,
    currency,
    service: target.name,
    createdAt: new Date().toISOString(),
    ...(target.wallet ? { recipient: target.wallet } : {}),
  };

  if (isFree) {
    return {
      ...baseReceipt,
      amount: "0",
      status: "skipped",
      receipt: "Free target; no payment required.",
    };
  }

  if (!allowPaid) {
    return {
      ...baseReceipt,
      status: "skipped",
      receipt: "Paid execution disabled. Re-run with --allow-paid only after the payment adapter is verified.",
    };
  }

  return {
    ...baseReceipt,
    status: "failed",
    receipt: "Paid route requested, but this runner does not yet sign SAP/x402 payments. No funds were sent.",
  };
}

async function runProbe(
  auditJobId: string,
  target: AgentTarget,
  plannedTarget: PlannedTarget,
  payment: PaymentReceipt,
): Promise<ProbeResult> {
  const startedAt = new Date().toISOString();
  const probeId = `probe_${randomUUID()}`;
  const request = {
    method: "GET",
    url: target.endpoint,
    paid: payment.status === "settled",
    purpose: "Proofline one-shot audit probe",
  };

  if (payment.status === "failed") {
    const failedProbe: ProbeResult = {
      probeId,
      auditJobId,
      targetAgentId: target.agentId,
      targetToolId: target.toolId,
      request,
      status: "failed",
      startedAt,
      completedAt: new Date().toISOString(),
    };
    if (payment.receipt) {
      failedProbe.error = payment.receipt;
    }
    return failedProbe;
  }

  const observation = await observeUrl(target.endpoint, "GET");
  const status = isReachableStatus(observation.status) ? "success" : "failed";
  const response = {
    ...observation,
    targetMetadata: {
      pricingTier: plannedTarget.pricingTier,
      route: plannedTarget.route,
      token: plannedTarget.token,
      pricePerCallDisplay: plannedTarget.pricePerCallDisplay,
      protocolIds: plannedTarget.protocolIds,
      agentUri: plannedTarget.agentUri,
    },
  };

  const result: ProbeResult = {
    probeId,
    auditJobId,
    targetAgentId: target.agentId,
    targetToolId: target.toolId,
    request,
    response,
    status,
    latencyMs: observation.latencyMs,
    startedAt,
    completedAt: new Date().toISOString(),
  };
  if (status === "failed") {
    result.error = observation.error ?? `HTTP status ${observation.status}`;
  }
  return result;
}

async function runAceAnalysis(
  auditJobId: string,
  target: AgentTarget,
  plannedTarget: PlannedTarget,
  sentinelCheck: SentinelCheck,
  payment: PaymentReceipt,
  probeResult: ProbeResult,
  aceApiKey: string,
): Promise<AceAnalysisResult> {
  const createdAt = new Date().toISOString();
  const prompt = [
    "You are Proofline, an execution auditor for SAP agents.",
    "Analyze this SAP agent probe and return strict JSON only with keys:",
    "outputQualityScore number 0-100, capabilityMatchScore number 0-100, summary string, riskFlags string[].",
    "Allowed riskFlags: TOOL_ENDPOINT_UNREACHABLE, CAPABILITY_MISMATCH, GENERIC_RESPONSE, SENTINEL_WARNING, PRICE_TOO_HIGH.",
    "",
    JSON.stringify(
      {
        target,
        plannedTarget: {
          name: plannedTarget.name,
          pda: plannedTarget.pda,
          endpoint: plannedTarget.endpoint,
          agentUri: plannedTarget.agentUri,
          route: plannedTarget.route,
          token: plannedTarget.token,
          pricePerCallDisplay: plannedTarget.pricePerCallDisplay,
          protocolIds: plannedTarget.protocolIds,
          capabilitiesCount: plannedTarget.capabilitiesCount,
        },
        sentinelCheck,
        payment: {
          status: payment.status,
          method: payment.method,
          amount: payment.amount,
          currency: payment.currency,
          receipt: payment.receipt,
        },
        probeResult,
      },
      null,
      2,
    ).slice(0, 12000),
  ].join("\n");

  try {
    const response = await fetch("https://api.acedata.cloud/openai/chat/completions", {
      method: "POST",
      headers: {
        accept: "application/json",
        authorization: `Bearer ${aceApiKey}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({
        model: ACE_CHAT_MODEL,
        messages: [
          {
            role: "user",
            content: prompt,
          },
        ],
        temperature: 0,
        max_tokens: 500,
        response_format: {
          type: "json_object",
        },
      }),
    });
    const raw = await response.json();
    const content = extractAceContent(raw);
    const verdict = parseAceVerdict(content);

    if (!response.ok) {
      return {
        analysisId: `ace_${randomUUID()}`,
        auditJobId,
        servicesUsed: ["ace_openai_chat_completions"],
        riskFlags: ["GENERIC_RESPONSE"],
        summary: `Ace analysis returned HTTP ${response.status}. Heuristic scoring was used.`,
        raw,
        createdAt,
      };
    }

    return {
      analysisId: `ace_${randomUUID()}`,
      auditJobId,
      servicesUsed: ["ace_openai_chat_completions"],
      outputQualityScore: verdict.outputQualityScore,
      capabilityMatchScore: verdict.capabilityMatchScore,
      summary: verdict.summary,
      riskFlags: verdict.riskFlags,
      raw,
      createdAt,
    };
  } catch (error) {
    return {
      analysisId: `ace_${randomUUID()}`,
      auditJobId,
      servicesUsed: ["ace_openai_chat_completions"],
      riskFlags: ["GENERIC_RESPONSE"],
      summary: `Ace analysis failed: ${error instanceof Error ? error.message : String(error)}. Heuristic scoring was used.`,
      createdAt,
    };
  }
}

function buildSkippedAceAnalysis(auditJobId: string): AceAnalysisResult {
  return {
    analysisId: `ace_${randomUUID()}`,
    auditJobId,
    servicesUsed: [],
    riskFlags: [],
    summary: "Ace analysis was skipped with --no-ace.",
    createdAt: new Date().toISOString(),
  };
}

async function observeUrl(url: string, method: "GET" | "HEAD"): Promise<HttpObservation> {
  const startedAt = Date.now();

  try {
    const response = await fetch(url, {
      method,
      headers: {
        accept: "application/json, text/plain;q=0.9, */*;q=0.8",
        "user-agent": "Proofline/0.1 execution-auditor",
      },
      signal: AbortSignal.timeout(15000),
    });
    const latencyMs = Date.now() - startedAt;
    const contentType = response.headers.get("content-type");
    const observation: HttpObservation = {
      url,
      method,
      ok: response.ok,
      status: response.status,
      statusText: response.statusText,
      contentType,
      latencyMs,
    };

    if (method === "GET") {
      observation.bodyPreview = await readBodyPreview(response, contentType);
    }

    return observation;
  } catch (error) {
    return {
      url,
      method,
      ok: false,
      status: null,
      statusText: null,
      contentType: null,
      latencyMs: Date.now() - startedAt,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

async function readBodyPreview(response: Response, contentType: string | null): Promise<unknown> {
  const text = (await response.text()).slice(0, MAX_PREVIEW_CHARS);

  if (contentType?.includes("application/json")) {
    try {
      return JSON.parse(text);
    } catch {
      return text;
    }
  }

  return text;
}

function shouldFollowUpWithGet(observation: HttpObservation | null): boolean {
  if (!observation) return true;
  return observation.status === 405 || observation.status === 403 || observation.status === null;
}

function isReachableStatus(status: number | null): boolean {
  return status !== null && status >= 200 && status < 500;
}

function extractAceContent(raw: unknown): string {
  if (!isRecord(raw)) return "";
  const choices = raw.choices;
  if (!Array.isArray(choices)) return "";
  const firstChoice = choices[0];
  if (!isRecord(firstChoice)) return "";
  const message = firstChoice.message;
  if (!isRecord(message)) return "";
  return typeof message.content === "string" ? message.content : "";
}

function parseAceVerdict(content: string): AceVerdict {
  const parsed = parseJsonObject(content);
  const riskFlags = Array.isArray(parsed.riskFlags) ? parsed.riskFlags.filter(isRiskFlag) : [];

  return {
    outputQualityScore: clampScore(Number(parsed.outputQualityScore ?? 50)),
    capabilityMatchScore: clampScore(Number(parsed.capabilityMatchScore ?? 50)),
    summary: typeof parsed.summary === "string" ? parsed.summary : "Ace returned an unstructured analysis response.",
    riskFlags,
  };
}

function parseJsonObject(content: string): Record<string, unknown> {
  try {
    const parsed = JSON.parse(content) as unknown;
    return isRecord(parsed) ? parsed : {};
  } catch {
    const match = content.match(/\{[\s\S]*\}/);
    if (!match) return {};
    try {
      const parsed = JSON.parse(match[0]) as unknown;
      return isRecord(parsed) ? parsed : {};
    } catch {
      return {};
    }
  }
}

function mergeRiskFlags(
  sentinelCheck: SentinelCheck,
  payment: PaymentReceipt,
  probeResult: ProbeResult,
  aceAnalysis: AceAnalysisResult,
): RiskFlag[] {
  const flags = new Set<RiskFlag>(aceAnalysis.riskFlags);

  if (sentinelCheck.status === "warning" || sentinelCheck.status === "failed") {
    flags.add("SENTINEL_WARNING");
  }

  if (payment.status === "failed") {
    flags.add("PAYMENT_FAILED");
  }

  if (probeResult.status === "failed") {
    flags.add("TOOL_ENDPOINT_UNREACHABLE");
  }

  if (payment.status === "settled" && probeResult.status !== "success") {
    flags.add("NO_OUTPUT_AFTER_PAYMENT");
  }

  return [...flags];
}

function reliabilityScore(probeResult: ProbeResult): number {
  if (probeResult.status !== "success") return 20;
  const response = isRecord(probeResult.response) ? probeResult.response : {};
  const status = typeof response.status === "number" ? response.status : null;
  if (status !== null && status >= 200 && status < 300) return 90;
  if (status === 402) return 70;
  return 60;
}

function heuristicCapabilityScore(probeResult: ProbeResult): number {
  if (probeResult.status !== "success") return 25;
  return 60;
}

function paymentIntegrityScore(payment: PaymentReceipt): number {
  if (payment.status === "settled") return 100;
  if (payment.status === "skipped" && Number(payment.amount) > 0) return 25;
  if (payment.status === "skipped") return 65;
  if (payment.status === "pending") return 40;
  return 0;
}

function publicFootprintScore(target: PlannedTarget): number {
  let score = 0;
  if (target.endpoint) score += 50;
  if (target.agentUri) score += 30;
  if (target.protocolIds.length > 0) score += 20;
  return score;
}

function safetyScore(sentinelCheck: SentinelCheck): number {
  if (sentinelCheck.status === "healthy") return 90;
  if (sentinelCheck.status === "warning") return 60;
  if (sentinelCheck.status === "failed") return 20;
  return 50;
}

function clampScore(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.max(0, Math.min(100, Math.round(value)));
}

function isRiskFlag(value: unknown): value is RiskFlag {
  return (
    value === "NO_OUTPUT_AFTER_PAYMENT" ||
    value === "PAYMENT_FAILED" ||
    value === "TOOL_ENDPOINT_UNREACHABLE" ||
    value === "CAPABILITY_MISMATCH" ||
    value === "GENERIC_RESPONSE" ||
    value === "SENTINEL_WARNING" ||
    value === "MISSING_PUBLIC_FOOTPRINT" ||
    value === "PRICE_TOO_HIGH" ||
    value === "REPEATED_IDENTICAL_OUTPUT"
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

async function writeJson(path: string, value: unknown): Promise<string> {
  const outputPath = resolve(path);
  await mkdir(dirname(outputPath), { recursive: true });
  await writeFile(outputPath, `${JSON.stringify(value, null, 2)}\n`, "utf8");
  return outputPath;
}

main().catch(async (error: unknown) => {
  const message = error instanceof Error ? error.message : String(error);
  const stack = error instanceof Error ? error.stack : undefined;
  await writeJson(`data/runs/audit_error_${Date.now()}.json`, {
    message,
    stack,
    timestamp: new Date().toISOString(),
  });
  console.error(
    JSON.stringify({
      level: "error",
      message: "Proofline one-shot audit failed",
      error: message,
      stack,
      timestamp: new Date().toISOString(),
    }),
  );
  process.exitCode = 1;
});
