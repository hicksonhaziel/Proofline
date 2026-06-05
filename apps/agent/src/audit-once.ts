import { createHash, createPrivateKey, randomUUID, sign as cryptoSign } from "node:crypto";
import { copyFile, mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import {
  assertProofPacket,
  createProofPacketId,
  scoreExecution,
  type AceAnalysisResult,
  type AgentTarget,
  type AuditJob,
  type ExecutionProofPacket,
  type PaymentReceipt,
  type ProbeResult,
  type RiskFlag,
  type SentinelCheck,
} from "../../../packages/core/src/index.js";
import type { RuntimeStore } from "../../../packages/db/src/index.js";
import {
  AceDataCloudClient,
  extractAceChatContent,
  SentinelClient,
  type SentinelGate,
  type AceServiceResult,
} from "../../../packages/integrations/src/index.js";
import { loadConfig, safeConfigSummary } from "./config.js";
import { loadKeypairFromFile } from "./keypair.js";
import { createLogger } from "./logger.js";
import { PaymentRouter } from "./payment-router.js";
import { createProoflineStore } from "./storage.js";

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
  republishLatest: boolean;
  rebuildLedger: boolean;
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

interface AceArtifacts {
  directory: string;
  searchPath?: string;
  translationPath?: string;
  imagePath?: string;
  imageUrl?: string;
  imageResponsePath?: string;
  summaryPath?: string;
}

interface PreflightResult {
  sentinelCheck: SentinelCheck;
  gate: SentinelGate;
}

const PLAN_PATH = "data/sap/audit-target-plan.json";
const MAX_PREVIEW_CHARS = 6000;
const CARD_TEMPLATE_PATH = "public/card-temp1.png";

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

  if (args.rebuildLedger) {
    const publicProof = await rebuildPublicProofsFromStoredPackets(config.sapKeypairPath);
    logger.info("Rebuilt public proofs and evidence ledger from stored packets", {
      publicProof,
      note: "No audit, Ace call, SOL transaction, or x402 payment was executed.",
    });
    return;
  }

  if (args.republishLatest) {
    const latestPacket = normalizeProofPacket(JSON.parse(await readFile("public/proofs/latest.json", "utf8")) as ExecutionProofPacket);
    assertProofPacket(latestPacket);
    const signedPacket = await finalizeProofPacket(await localizePacketProofCard(latestPacket), config.sapKeypairPath);
    const publicProof = await publishPublicProofPacket(signedPacket);
    logger.info("Republished latest public proof pages", {
      proofPacketId: signedPacket.proofPacketId,
      publicProof,
      note: "No audit, Ace call, SOL transaction, or x402 payment was executed.",
    });
    return;
  }

  const store = createProoflineStore(config);
  await store.ensureReady();

  const plannedTarget = await selectTarget(args.target, store);
  const target = toAgentTarget(plannedTarget);
  const startedAt = new Date().toISOString();
  const prooflineWallet = await readWalletAddress(config.sapKeypairPath);
  const sentinelClient = new SentinelClient({
    ...(process.env.SENTINEL_BASE_URL ? { baseUrl: process.env.SENTINEL_BASE_URL } : {}),
    ...(process.env.SENTINEL_TOOL_NAME ? { defaultToolName: process.env.SENTINEL_TOOL_NAME } : {}),
    timeoutMs: Number(process.env.SENTINEL_TIMEOUT_MS ?? 15000),
    retries: Number(process.env.SENTINEL_RETRIES ?? 2),
  });

  logger.info("Selected audit target", {
    name: target.name,
    agentId: target.agentId,
    endpoint: target.endpoint,
    price: target.price,
    currency: target.currency,
    route: plannedTarget.route,
    status: plannedTarget.status,
  });

  const preflight = await runPreflight(
    plannedTarget,
    config.sentinelAgentId,
    config.limits.maxSpendPerAuditUsdc,
    prooflineWallet,
    sentinelClient,
  );
  const sentinelCheck = preflight.sentinelCheck;
  const preflightGate = preflight.gate;

  logger.info("Sentinel preflight evaluated", {
    sentinelStatus: sentinelCheck.status,
    proceed: preflightGate.proceed,
    reasons: preflightGate.reasons,
    warnings: preflightGate.warnings,
  });

  const paymentRouter = new PaymentRouter(config, logger);
  const payment = await paymentRouter.execute({
    auditJobId,
    allowPaid: args.allowPaid,
    sentinelProceed: preflightGate.proceed,
    target: toPaymentTarget(plannedTarget),
  });
  const probeResult = preflightGate.proceed
    ? await runProbe(auditJobId, target, plannedTarget, payment)
    : buildBlockedProbeResult(auditJobId, target, plannedTarget, preflightGate);
  // Sentinel gates spending against the target agent. Ace analysis still runs
  // on skipped probes so the audit can produce paid x402 evidence and a verdict.
  const aceAnalysis = args.useAce
    ? await runAceAnalysis(auditJobId, target, plannedTarget, sentinelCheck, payment, probeResult, config)
    : buildSkippedAceAnalysis(auditJobId, "Ace analysis was skipped with --no-ace.");
  const acePaymentReceipts = acePaymentReceiptsFromAnalysis(auditJobId, aceAnalysis);
  for (const receipt of acePaymentReceipts) {
    await paymentRouter.persistReceipt(receipt);
  }
  const payments = [payment, ...acePaymentReceipts];

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
  const finalAuditStatus: ExecutionProofPacket["auditStatus"] = preflightGate.proceed ? "completed" : "skipped";

  const packetWithoutId: Omit<ExecutionProofPacket, "proofPacketId"> = {
    version: "0.1" as const,
    auditStatus: finalAuditStatus,
    targetAgent: target,
    auditJob: {
      auditJobId,
      target,
      status: finalAuditStatus,
      createdAt: startedAt,
      startedAt,
      completedAt,
      maxSpendUsdc: config.limits.maxSpendPerAuditUsdc,
    },
    sentinelCheck,
    payments,
    probeResult,
    aceAnalysis,
    scores,
    riskFlags,
    artifacts: buildPacketArtifacts(aceAnalysis),
    createdAt: completedAt,
    auditorAgent: {
      name: "Proofline" as const,
      sapAgentId: "GGN3y79CAejSM1xhNgBdQNatKQv7WegJBvo5aaAYYKzL",
    },
  };

  let packet: ExecutionProofPacket = {
    proofPacketId: createProofPacketId(packetWithoutId),
    ...packetWithoutId,
  };
  assertProofPacket(packet);
  if (store.mode === "supabase") {
    packet = normalizeSupabaseProofCard(packet);
  } else {
    packet = await localizePacketProofCard(packet);
  }
  packet = await finalizeProofPacket(packet, config.sapKeypairPath);

  const proofPacketPath = await store.saveProofPacket(packet);
  const publicProof = store.mode === "supabase" ? supabaseProofReference(packet) : await publishPublicProofPacket(packet);
  const runStatePath = await store.saveAuditRun(auditJobId, {
    auditJobId,
    proofPacketId: packet.proofPacketId,
    auditStatus: finalAuditStatus,
    target: {
      name: target.name,
      agentId: target.agentId,
      endpoint: target.endpoint,
    },
    sentinel: {
      status: sentinelCheck.status,
      message: sentinelCheck.message,
      gate: preflightGate,
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
    publicProof,
    completedAt,
  });

  logger.info("Proofline audit complete", {
    proofPacketId: packet.proofPacketId,
    auditStatus: finalAuditStatus,
    verdict: packet.scores.verdict,
    overallScore: packet.scores.overall,
    riskFlags,
    paymentStatus: payment.status,
    proofPacketPath,
    publicProof,
    runStatePath,
  });
}

function supabaseProofReference(packet: ExecutionProofPacket): Record<string, string | null> {
  return {
    ledger: "supabase:proof_packets",
    ledgerJson: null,
    latestJson: null,
    proofJson: `/proofs/${packet.proofPacketId}.json`,
    latestHtml: "/live",
    proofHtml: `/proofs/${packet.proofPacketId}`,
    latestCard: packet.artifacts.proofCardPath ?? null,
    proofCard: packet.artifacts.proofCardPath ?? null,
  };
}

function parseArgs(argv: string[]): CliArgs {
  const targetIndex = argv.findIndex((arg) => arg === "--target");
  const target = targetIndex >= 0 ? argv[targetIndex + 1] : undefined;

  return {
    target: target && !target.startsWith("--") ? target : undefined,
    allowPaid: argv.includes("--allow-paid"),
    useAce: !argv.includes("--no-ace"),
    republishLatest: argv.includes("--republish-latest"),
    rebuildLedger: argv.includes("--rebuild-ledger"),
  };
}

async function selectTarget(targetQuery: string | undefined, store: RuntimeStore): Promise<PlannedTarget> {
  if (store.mode === "supabase") {
    const jobs = await store.readAuditJobs();
    const candidates = jobs.map((job) => plannedTargetFromAuditJob(job)).filter(isUsableTarget);
    if (candidates.length === 0) {
      throw new Error("No usable queued audit jobs found in Supabase. Run npm run sap:discover first.");
    }

    if (targetQuery) {
      const normalized = targetQuery.toLowerCase();
      const match = candidates.find(
        (target) =>
          target.name.toLowerCase() === normalized ||
          target.name.toLowerCase().includes(normalized) ||
          target.pda === targetQuery,
      );
      if (!match) {
        throw new Error(`No queued Supabase target matched "${targetQuery}"`);
      }
      return match;
    }

    return candidates.find((target) => target.status === "free") ?? candidates[0]!;
  }

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

function plannedTargetFromAuditJob(job: AuditJob): PlannedTarget {
  return {
    name: job.target.name,
    pda: job.target.agentId,
    wallet: null,
    endpoint: job.target.endpoint,
    agentUri: null,
    protocolIds: [],
    capabilitiesCount: 0,
    pricingTier: job.target.toolId,
    route: job.target.paymentMethod === "sap_escrow" ? "sap_escrow" : job.target.paymentMethod === "x402" ? "x402" : "unknown",
    token: job.target.currency,
    pricePerCall: null,
    pricePerCallDisplay: job.target.price,
    status: "good_audit_target",
    reasons: [job.target.description],
  };
}

async function readWalletAddress(keypairPath: string): Promise<string> {
  const keypair = await loadKeypairFromFile(keypairPath);
  return keypair.publicKey.toBase58();
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

function toPaymentTarget(target: PlannedTarget): {
  name: string;
  agentId: string;
  wallet: string | null;
  endpoint: string | null;
  route: "x402" | "sap_escrow" | "instant" | "batched" | "unknown";
  token: string;
  pricePerCall: string | null;
  pricePerCallDisplay: string | null;
} {
  return {
    name: target.name,
    agentId: target.pda,
    wallet: target.wallet,
    endpoint: target.endpoint,
    route: target.route,
    token: target.token,
    pricePerCall: target.pricePerCall,
    pricePerCallDisplay: target.pricePerCallDisplay,
  };
}

function acePaymentReceiptsFromAnalysis(auditJobId: string, aceAnalysis: AceAnalysisResult): PaymentReceipt[] {
  const raw = isRecord(aceAnalysis.raw) ? aceAnalysis.raw : {};
  const x402Payments = Array.isArray(raw.x402Payments) ? raw.x402Payments : [];

  return x402Payments.filter(isRecord).map((item, index) => {
    const status = item.status === "settled" ? "settled" : item.status === "failed" ? "failed" : "pending";
    const transactionHash = typeof item.transactionHash === "string" ? item.transactionHash : undefined;
    const createdAt = new Date().toISOString();
    return {
      paymentId: `pay_ace_${auditJobId}_${index + 1}`,
      auditJobId,
      provider: "ace_data_cloud",
      method: "x402",
      amount: typeof item.amount === "string" ? item.amount : "0",
      currency: "USDC",
      ...(typeof item.payTo === "string" && item.payTo.length > 0 ? { recipient: item.payTo } : {}),
      service: typeof item.service === "string" ? item.service : "ace_data_cloud_api",
      status,
      receipt: JSON.stringify(
        trimLargePayload({
          endpoint: item.endpoint,
          network: item.network,
          scheme: item.scheme,
          asset: item.asset,
          atomicAmount: item.atomicAmount,
          payer: item.payer,
          responseHeaders: item.responseHeaders,
          transactionHash,
          note:
            status === "pending"
              ? "Ace x402 quote captured in dry-run mode; no X-Payment signature was sent."
              : "Ace x402 per-request payment captured from API call.",
        }),
      ),
      ...(transactionHash ? { transactionHash } : {}),
      createdAt,
      ...(status === "settled" ? { confirmedAt: createdAt } : {}),
    } satisfies PaymentReceipt;
  });
}

async function runPreflight(
  target: PlannedTarget,
  sentinelAgentId: string,
  maxSpendUsdc: number,
  wallet: string,
  sentinelClient: SentinelClient,
): Promise<PreflightResult> {
  try {
    return await sentinelClient.checkTarget({
      sentinelAgentId,
      wallet,
      maxSpendUsdc,
      target: {
        agentId: target.pda,
        name: target.name,
        endpoint: target.endpoint,
        agentUri: target.agentUri,
        pricePerCall: target.pricePerCall,
        pricePerCallDisplay: target.pricePerCallDisplay,
        token: target.token,
        route: target.route,
      },
    });
  } catch (error) {
    const checkedAt = new Date().toISOString();
    const endpointHead = target.endpoint ? await observeUrl(target.endpoint, "HEAD") : null;
    const endpointGet = shouldFollowUpWithGet(endpointHead) && target.endpoint ? await observeUrl(target.endpoint, "GET") : null;
    const agentUriGet = target.agentUri ? await observeUrl(target.agentUri, "GET") : null;
    const observations = [endpointHead, endpointGet, agentUriGet].filter((item): item is HttpObservation => item !== null);
    const hasReachableEndpoint = observations.some((item) => item.url === target.endpoint && isReachableStatus(item.status));
    const gate: SentinelGate = {
      proceed: false,
      reasons: [
        `sentinel preflight request failed: ${error instanceof Error ? error.message : String(error)}`,
        ...(hasReachableEndpoint ? [] : ["target endpoint unreachable during fallback preflight"]),
      ],
      warnings: hasReachableEndpoint ? ["fallback preflight reached target endpoint but Sentinel was unavailable"] : [],
    };

    return {
      sentinelCheck: {
        status: hasReachableEndpoint ? "warning" : "failed",
        sentinelAgentId,
        checkedAt,
        raw: {
          mode: "sentinel_preflight_fallback",
          observations,
          gate,
        },
        message: gate.reasons.join("; "),
      },
      gate,
    };
  }
}

function buildBlockedProbeResult(
  auditJobId: string,
  target: AgentTarget,
  plannedTarget: PlannedTarget,
  preflightGate: SentinelGate,
): ProbeResult {
  const startedAt = new Date().toISOString();
  return {
    probeId: `probe_${randomUUID()}`,
    auditJobId,
    targetAgentId: target.agentId,
    targetToolId: target.toolId,
    request: {
      method: "GET",
      url: target.endpoint,
      paid: false,
      purpose: "Probe skipped by Sentinel preflight gate",
    },
    response: {
      skipped: true,
      preflightGate,
      targetMetadata: {
        pricingTier: plannedTarget.pricingTier,
        route: plannedTarget.route,
        token: plannedTarget.token,
        pricePerCallDisplay: plannedTarget.pricePerCallDisplay,
      },
    },
    status: "not_run",
    error: `Skipped: ${preflightGate.reasons.join("; ")}`,
    startedAt,
    completedAt: new Date().toISOString(),
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
    method: "HEAD+GET",
    url: target.endpoint,
    paid: payment.status === "settled",
    purpose: "Proofline one-shot audit probe",
    probeTypes: ["liveness", "capability_match", "delivery_after_payment"],
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

  const livenessObservation = await observeUrl(target.endpoint, "HEAD");
  const getObservation = await observeUrl(target.endpoint, "GET");
  const status = isReachableStatus(livenessObservation.status) || isReachableStatus(getObservation.status) ? "success" : "failed";
  const capabilityEvidence = extractCapabilityEvidence(getObservation);
  const response = {
    probeTypeResults: [
      {
        type: "liveness",
        ok: isReachableStatus(livenessObservation.status),
        status: livenessObservation.status,
        latencyMs: livenessObservation.latencyMs,
      },
      {
        type: "capability_match",
        ok: capabilityEvidence.hasUsableOutput,
        status: getObservation.status,
        evidence: capabilityEvidence,
      },
      {
        type: "delivery_after_payment",
        ok: payment.status === "settled" ? capabilityEvidence.hasUsableOutput : false,
        status: getObservation.status,
        paymentStatus: payment.status,
        note:
          payment.status === "settled"
            ? "Checks whether the target produced usable output after payment."
            : "Target payment was not settled, so delivery-after-payment is not claimed.",
      },
    ],
    observations: {
      liveness: livenessObservation,
      execution: getObservation,
    },
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
    latencyMs: livenessObservation.latencyMs + (getObservation === livenessObservation ? 0 : getObservation.latencyMs),
    startedAt,
    completedAt: new Date().toISOString(),
  };
  if (status === "failed") {
    result.error = getObservation.error ?? livenessObservation.error ?? `HTTP status ${getObservation.status ?? livenessObservation.status}`;
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
  config: ReturnType<typeof loadConfig>,
): Promise<AceAnalysisResult> {
  const createdAt = new Date().toISOString();
  if (!config.aceApiKey && !config.aceX402WalletKey) {
    return buildSkippedAceAnalysis(
      auditJobId,
      "Ace analysis requires either ACE_X402_WALLET_KEY for per-request x402 payment or ACE_API_KEY for legacy API-key mode.",
    );
  }

  const client = new AceDataCloudClient({
    ...(config.aceApiKey ? { apiKey: config.aceApiKey } : {}),
    ...(config.aceX402WalletKey ? { x402WalletKey: config.aceX402WalletKey } : {}),
    x402PaymentMode: process.env.PAYMENT_MODE === "send" && process.env.PAYMENT_CONFIRM_SPEND === "true" ? "send" : "dry-run",
    x402PreferScheme: "exact",
    maxSpendPerRequestUsdc: config.limits.maxSpendPerAuditUsdc,
    maxTotalSpendUsdc: config.limits.maxSpendPerAuditUsdc,
    ...(process.env.ACE_CHAT_MODEL ? { chatModel: process.env.ACE_CHAT_MODEL } : {}),
    ...(process.env.ACE_IMAGE_MODEL ? { imageModel: process.env.ACE_IMAGE_MODEL } : {}),
    timeoutMs: Number(process.env.ACE_TIMEOUT_MS ?? 180000),
  });
  const artifacts: AceArtifacts = {
    directory: config.storageMode === "supabase" ? `supabase:ace_artifacts/${auditJobId}` : resolve("data/artifacts", auditJobId),
  };
  const calls: AceServiceResult[] = [];

  try {
    const search = await client.search({
      query: buildPublicFootprintQuery(target, plannedTarget),
      number: 5,
      country: "US",
      language: "en",
    });
    calls.push(search);
    artifacts.searchPath = await writeJsonArtifact(config, `data/artifacts/${auditJobId}/ace-serp-search.json`, trimAcePayload(search));

    const chat = await client.chatJson(
      [
        {
          role: "system",
          content:
            "You are Proofline, an execution auditor for SAP agents. Your job is to judge whether a paid agent endpoint is real, reachable, priced clearly, and aligned with its advertised SAP metadata.",
        },
        {
          role: "user",
          content: buildAceAuditPrompt(target, plannedTarget, sentinelCheck, payment, probeResult, search),
        },
      ],
      "Return strict JSON only with keys: outputQualityScore number 0-100, capabilityMatchScore number 0-100, summary string, riskFlags string[]. Allowed riskFlags: TOOL_ENDPOINT_UNREACHABLE, CAPABILITY_MISMATCH, GENERIC_RESPONSE, SENTINEL_WARNING, PRICE_TOO_HIGH, MISSING_PUBLIC_FOOTPRINT.",
    );
    calls.push(chat);
    const content = extractAceChatContent(chat.data);
    const verdict = parseAceVerdict(content);
    artifacts.summaryPath = await writeJsonArtifact(config, `data/artifacts/${auditJobId}/ace-analysis.json`, {
      verdict,
      raw: trimAcePayload(chat),
    });

    if (config.flags.enableAceTranslation) {
      const translationInput = buildTranslationInput(target, plannedTarget, verdict, search);
      const translation = await client.translate({
        input: translationInput,
        locale: "zh-CN",
        extension: "md",
      });
      calls.push(translation);
      artifacts.translationPath = await writeTextOrJsonArtifact(
        config,
        `data/artifacts/${auditJobId}/ace-translation-zh-CN.md`,
        translation,
      );
    }

    if (config.flags.enableAceImage) {
      const template = await readFile(resolve(CARD_TEMPLATE_PATH));
      const image = await client.editImage({
        image: new Blob([template], { type: "image/png" }),
        fileName: "card-temp1.png",
        prompt: buildProofCardPrompt(target, plannedTarget, verdict, payment, probeResult),
        size: "1024x1024",
      });
      calls.push(image);
      const imageArtifacts = await writeImageArtifacts(config, auditJobId, image);
      if (imageArtifacts.imagePath) {
        artifacts.imagePath = imageArtifacts.imagePath;
      }
      if (imageArtifacts.imageUrl) {
        artifacts.imageUrl = imageArtifacts.imageUrl;
      }
      artifacts.imageResponsePath = imageArtifacts.imageResponsePath;
    }

    const servicesUsed = calls.filter((call) => call.ok).map((call) => call.service);
    const failedCalls = calls.filter((call) => !call.ok);
    const riskFlags = new Set<RiskFlag>(verdict.riskFlags);
    const x402Payments = calls.flatMap((call) => (call.x402 ? [{ service: call.service, endpoint: call.endpoint, ...call.x402 }] : []));
    if (!chat.ok) riskFlags.add("GENERIC_RESPONSE");
    if (!search.ok) riskFlags.add("MISSING_PUBLIC_FOOTPRINT");

    return {
      analysisId: `ace_${randomUUID()}`,
      auditJobId,
      servicesUsed,
      ...(chat.ok
        ? {
            outputQualityScore: verdict.outputQualityScore,
            capabilityMatchScore: verdict.capabilityMatchScore,
          }
        : {}),
      summary: buildAceSummary(verdict, servicesUsed, failedCalls),
      riskFlags: [...riskFlags],
      raw: {
        mode: "ace_full_pipeline",
        servicesAttempted: calls.map((call) => ({
          service: call.service,
          endpoint: call.endpoint,
          ok: call.ok,
          status: call.status,
          latencyMs: call.latencyMs,
          error: call.error,
          x402: call.x402,
        })),
        x402Payments,
        x402Summary: summarizeAceX402Payments(x402Payments),
        artifacts,
        note: "servicesUsed contains only successful Ace Data Cloud service calls.",
      },
      createdAt,
    };
  } catch (error) {
    if (calls.length > 0 && config.storageMode === "file") {
      await writeJsonArtifact(config, `data/artifacts/${auditJobId}/ace-partial-failure.json`, {
        error: error instanceof Error ? error.message : String(error),
        calls: calls.map(trimAcePayload),
        artifacts,
      });
    }

    return {
      analysisId: `ace_${randomUUID()}`,
      auditJobId,
      servicesUsed: calls.filter((call) => call.ok).map((call) => call.service),
      riskFlags: ["GENERIC_RESPONSE"],
      summary: `Ace full pipeline failed: ${error instanceof Error ? error.message : String(error)}. Heuristic scoring was used.`,
      raw: {
        mode: "ace_full_pipeline",
        servicesAttempted: calls.map((call) => ({
          service: call.service,
          endpoint: call.endpoint,
          ok: call.ok,
          status: call.status,
          latencyMs: call.latencyMs,
          error: call.error,
          x402: call.x402,
        })),
        x402Payments: calls.flatMap((call) => (call.x402 ? [{ service: call.service, endpoint: call.endpoint, ...call.x402 }] : [])),
        x402Summary: summarizeAceX402Payments(calls.flatMap((call) => (call.x402 ? [{ service: call.service, endpoint: call.endpoint, ...call.x402 }] : []))),
        artifacts,
      },
      createdAt,
    };
  }
}

function buildAceAuditPrompt(
  target: AgentTarget,
  plannedTarget: PlannedTarget,
  sentinelCheck: SentinelCheck,
  payment: PaymentReceipt,
  probeResult: ProbeResult,
  search: AceServiceResult,
): string {
  return [
    "Analyze this SAP agent audit evidence. Be strict and practical.",
    "If the endpoint is only metadata or returns a payment-required response, score reliability fairly but do not pretend the tool output was fully delivered.",
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
        publicFootprintSearch: trimAcePayload(search),
      },
      null,
      2,
    ).slice(0, 14000),
  ].join("\n");
}

function buildPublicFootprintQuery(target: AgentTarget, plannedTarget: PlannedTarget): string {
  const host = target.endpoint ? safeHostname(target.endpoint) : "";
  const agentUriHost = plannedTarget.agentUri ? safeHostname(plannedTarget.agentUri) : "";
  return [`"${target.name}"`, host ? `"${host}"` : "", agentUriHost ? `"${agentUriHost}"` : "", "x402", "SAP agent"].filter(Boolean).join(" ");
}

function buildTranslationInput(
  target: AgentTarget,
  plannedTarget: PlannedTarget,
  verdict: AceVerdict,
  search: AceServiceResult,
): string {
  return [
    `# Proofline audit summary for ${target.name}`,
    "",
    `Agent PDA: ${plannedTarget.pda}`,
    `Endpoint: ${plannedTarget.endpoint ?? "unknown"}`,
    `Payment route: ${plannedTarget.route}`,
    `Advertised price: ${plannedTarget.pricePerCallDisplay ?? "unknown"}`,
    "",
    `Verdict summary: ${verdict.summary}`,
    `Output quality score: ${verdict.outputQualityScore}`,
    `Capability match score: ${verdict.capabilityMatchScore}`,
    `Risk flags: ${verdict.riskFlags.length > 0 ? verdict.riskFlags.join(", ") : "none"}`,
    "",
    "Public footprint search status:",
    JSON.stringify(
      {
        ok: search.ok,
        status: search.status,
        service: search.service,
        preview: extractSearchPreview(search.data),
      },
      null,
      2,
    ),
  ].join("\n");
}

function buildProofCardPrompt(
  target: AgentTarget,
  plannedTarget: PlannedTarget,
  verdict: AceVerdict,
  payment: PaymentReceipt,
  probeResult: ProbeResult,
): string {
  const auditDate = new Date().toISOString().slice(0, 10);
  const doneItems = [
    `ENDPOINT ${probeResult.status === "success" ? "REACHABLE" : "UNREACHABLE"}`,
    `${probeResult.status === "success" ? "HTTP RESPONSE VERIFIED" : "HTTP RESPONSE FAILED"}`,
    `${payment.status === "settled" ? "X402 PAYMENT FLOW TESTED" : "PAYMENT NOT EXECUTED"}`,
    `${payment.status === "settled" && probeResult.status === "success" ? "AGENT FUNCTIONAL EXECUTION" : "FUNCTIONAL EXECUTION UNPAID"}`,
  ];

  return [
    "EDIT THE PROVIDED TEMPLATE IMAGE ONLY. Do not create a new design.",
    "Preserve the exact Proofline branding, black/gold color palette, logo, borders, panels, icons, spacing, typography style, badge, score rings, and layout.",
    "Do not add characters, avatars, backgrounds, new logos, new panels, dates that are not provided, decorative scenes, paragraphs, or extra claims.",
    "Only replace the visible placeholder/data text in the existing template.",
    "Keep every replacement short enough to fit inside its existing box. If text is too long, abbreviate it instead of changing the design.",
    "Use these exact data replacements:",
    `AGENT_NAME -> ${shortCardText(target.name, 18)}`,
    `ROUTE_ID xXXX -> ${shortCardText(plannedTarget.route.toUpperCase(), 12)}`,
    `PRICE -> ${shortCardText(plannedTarget.pricePerCallDisplay ?? target.price, 22)}`,
    `BLOCKCHAIN NETWORK_NAME -> ${shortCardText(tokenNetworkLabel(plannedTarget.token), 16)}`,
    `OUTPUT SCORE -> ${verdict.outputQualityScore}/100`,
    `CAPABILITY SCORE -> ${verdict.capabilityMatchScore}/100`,
    `AUDIT DATE [CURRENT DATE] -> ${auditDate}`,
    `VERIFICATION ROWS -> ${doneItems.join(" | ")}`,
    "Green check marks should remain only for completed true items. Red cross marks should remain for not executed or failed items.",
    "Return a PNG that looks like the same template with updated audit data.",
  ].join(" ");
}

function buildAceSummary(verdict: AceVerdict, servicesUsed: string[], failedCalls: AceServiceResult[]): string {
  const failures =
    failedCalls.length > 0
      ? ` Failed Ace services: ${failedCalls.map((call) => `${call.service}${call.status ? ` HTTP ${call.status}` : ""}`).join(", ")}.`
      : "";
  return `${verdict.summary} Ace services used successfully: ${servicesUsed.length > 0 ? servicesUsed.join(", ") : "none"}.${failures}`;
}

function summarizeAceX402Payments(payments: Array<Record<string, unknown>>): Record<string, unknown> {
  const settled = payments.filter((payment) => payment.status === "settled");
  const quoted = payments.filter((payment) => payment.status === "quoted");
  const failed = payments.filter((payment) => payment.status === "failed");
  const totalSettledUsdc = settled.reduce((sum, payment) => {
    const amount = typeof payment.amount === "string" ? Number(payment.amount) : 0;
    return Number.isFinite(amount) ? sum + amount : sum;
  }, 0);

  return {
    totalPayments: payments.length,
    settled: settled.length,
    quoted: quoted.length,
    failed: failed.length,
    totalSettledUsdc: Number(totalSettledUsdc.toFixed(6)),
    services: payments.map((payment) => ({
      service: payment.service,
      status: payment.status,
      amount: payment.amount,
      transactionHash: payment.transactionHash,
    })),
  };
}

function shortCardText(value: string, maxLength: number): string {
  const clean = value.replace(/\s+/g, " ").trim();
  if (clean.length <= maxLength) return clean;
  return `${clean.slice(0, Math.max(0, maxLength - 1))}.`;
}

function tokenNetworkLabel(token: string): string {
  if (token === "SOL" || token === "USDC" || token.startsWith("SPL")) return "SOLANA";
  return "SOLANA";
}

function buildPacketArtifacts(aceAnalysis: AceAnalysisResult): ExecutionProofPacket["artifacts"] {
  const raw = isRecord(aceAnalysis.raw) ? aceAnalysis.raw : {};
  const artifacts = isRecord(raw.artifacts) ? raw.artifacts : {};
  const packetArtifacts: ExecutionProofPacket["artifacts"] = {};

  if (typeof artifacts.imagePath === "string") {
    packetArtifacts.proofCardPath = artifacts.imagePath;
  } else if (typeof artifacts.imageUrl === "string") {
    packetArtifacts.proofCardPath = artifacts.imageUrl;
  } else if (typeof artifacts.imageResponsePath === "string") {
    packetArtifacts.proofCardPath = artifacts.imageResponsePath;
  }

  return packetArtifacts;
}

function normalizeSupabaseProofCard(packet: ExecutionProofPacket): ExecutionProofPacket {
  const current = packet.artifacts.proofCardPath;
  if (isPublicProofCardAsset(current)) {
    return packet;
  }

  return {
    ...packet,
    artifacts: {
      ...packet.artifacts,
      proofCardPath: `/proofs/${packet.proofPacketId}-card.svg`,
    },
  };
}

function isPublicProofCardAsset(value?: string): boolean {
  if (!value || value.startsWith("supabase:")) return false;
  if (/\.json(?:[?#].*)?$/i.test(value)) return false;
  return value.startsWith("https://") || value.startsWith("http://") || value.startsWith("/proofs/") || value.startsWith("data:image/");
}

async function writeTextOrJsonArtifact(config: ReturnType<typeof loadConfig>, path: string, result: AceServiceResult): Promise<string> {
  if (config.storageMode === "supabase") {
    return supabaseArtifactRef(path.replace(/\.md$/, result.ok && isRecord(result.data) && typeof result.data.data === "string" ? ".md" : ".json"));
  }

  const outputPath = resolve(path);
  await mkdir(dirname(outputPath), { recursive: true });

  if (result.ok && isRecord(result.data) && typeof result.data.data === "string") {
    await writeFile(outputPath, result.data.data, "utf8");
    return outputPath;
  }

  await writeFile(outputPath.replace(/\.md$/, ".json"), `${JSON.stringify(trimAcePayload(result), null, 2)}\n`, "utf8");
  return outputPath.replace(/\.md$/, ".json");
}

async function writeImageArtifacts(
  config: ReturnType<typeof loadConfig>,
  auditJobId: string,
  result: AceServiceResult,
): Promise<{ imagePath?: string; imageUrl?: string; imageResponsePath: string }> {
  const imageResponsePath = await writeJsonArtifact(config, `data/artifacts/${auditJobId}/ace-proof-card-response.json`, trimAcePayload(result));
  const b64 = extractImageBase64(result.data);

  if (!result.ok) {
    return { imageResponsePath };
  }

  const imageUrl = extractImageUrl(result.data);
  if (config.storageMode === "supabase") {
    return imageUrl ? { imageUrl, imageResponsePath } : { imageResponsePath };
  }

  const imagePath = resolve(`data/artifacts/${auditJobId}/proof-card.png`);
  await mkdir(dirname(imagePath), { recursive: true });

  if (b64) {
    await writeFile(imagePath, Buffer.from(b64, "base64"));
    return { imagePath, imageResponsePath };
  }

  if (imageUrl) {
    try {
      const response = await fetch(imageUrl, {
        headers: {
          accept: "image/png,image/*;q=0.9,*/*;q=0.8",
          "user-agent": "Proofline/0.1 execution-auditor",
        },
        signal: AbortSignal.timeout(45000),
      });

      if (response.ok) {
        const bytes = Buffer.from(await response.arrayBuffer());
        await writeFile(imagePath, bytes);
        return { imagePath, imageUrl, imageResponsePath };
      }
    } catch {
      return { imageUrl, imageResponsePath };
    }
  }

  return { imageResponsePath };
}

function trimAcePayload(result: AceServiceResult): Record<string, unknown> {
  return {
    service: result.service,
    endpoint: result.endpoint,
    ok: result.ok,
    status: result.status,
    latencyMs: result.latencyMs,
    error: result.error,
    data: trimLargePayload(result.data),
  };
}

function trimLargePayload(value: unknown): unknown {
  if (typeof value === "string") {
    return value.length > 2000 ? `${value.slice(0, 2000)}...[trimmed ${value.length - 2000} chars]` : value;
  }

  if (Array.isArray(value)) {
    return value.slice(0, 10).map(trimLargePayload);
  }

  if (!isRecord(value)) {
    return value;
  }

  const output: Record<string, unknown> = {};
  for (const [key, item] of Object.entries(value)) {
    if (key === "b64_json" && typeof item === "string") {
      output[key] = `[base64 image omitted, ${item.length} chars]`;
    } else {
      output[key] = trimLargePayload(item);
    }
  }
  return output;
}

function extractImageBase64(data: unknown): string | undefined {
  if (!isRecord(data) || !Array.isArray(data.data)) return undefined;
  const first = data.data[0];
  if (!isRecord(first)) return undefined;
  return typeof first.b64_json === "string" ? first.b64_json : undefined;
}

function extractImageUrl(data: unknown): string | undefined {
  if (!isRecord(data) || !Array.isArray(data.data)) return undefined;
  const first = data.data[0];
  if (!isRecord(first)) return undefined;
  return typeof first.url === "string" ? first.url : undefined;
}

function extractSearchPreview(data: unknown): unknown {
  if (!isRecord(data)) return data;
  const nestedData = data.data;
  if (!isRecord(nestedData)) return trimLargePayload(data);
  return {
    organic: Array.isArray(nestedData.organic) ? nestedData.organic.slice(0, 3).map(trimLargePayload) : undefined,
    knowledgeGraph: isRecord(nestedData.knowledge_graph) ? trimLargePayload(nestedData.knowledge_graph) : undefined,
  };
}

function safeHostname(url: string): string {
  try {
    return new URL(url).hostname;
  } catch {
    return "";
  }
}

function buildSkippedAceAnalysis(auditJobId: string, reason?: string): AceAnalysisResult {
  return {
    analysisId: `ace_${randomUUID()}`,
    auditJobId,
    servicesUsed: [],
    riskFlags: [],
    summary: reason ?? "Ace analysis was skipped with --no-ace.",
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

function extractCapabilityEvidence(observation: HttpObservation): { hasUsableOutput: boolean; reason: string; preview?: unknown } {
  if (!isReachableStatus(observation.status)) {
    return {
      hasUsableOutput: false,
      reason: observation.error ?? `endpoint returned HTTP ${observation.status}`,
    };
  }

  if (observation.status === 401 || observation.status === 402 || observation.status === 403) {
    return {
      hasUsableOutput: true,
      reason: "endpoint returned a payment/auth-aware response, which is usable capability evidence before paid execution",
      preview: observation.bodyPreview,
    };
  }

  if (typeof observation.bodyPreview === "string") {
    const text = observation.bodyPreview.trim();
    return {
      hasUsableOutput: text.length > 0,
      reason: text.length > 0 ? "endpoint returned non-empty text output" : "endpoint returned empty text output",
      preview: text.slice(0, 500),
    };
  }

  if (isRecord(observation.bodyPreview)) {
    return {
      hasUsableOutput: Object.keys(observation.bodyPreview).length > 0,
      reason: "endpoint returned structured output",
      preview: observation.bodyPreview,
    };
  }

  return {
    hasUsableOutput: observation.ok,
    reason: observation.ok ? "endpoint returned a successful response" : "endpoint response did not include usable output",
    preview: observation.bodyPreview,
  };
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

async function finalizeProofPacket(packet: ExecutionProofPacket, keypairPath: string): Promise<ExecutionProofPacket> {
  const unsignedPacket: ExecutionProofPacket = { ...packet };
  delete unsignedPacket.signature;
  const signedPayload = stableJson(unsignedPacket);
  const packetHash = createHash("sha256").update(signedPayload).digest("hex");
  const keypair = await loadKeypairFromFile(keypairPath);
  const signatureBytes = signEd25519(Buffer.from(signedPayload, "utf8"), keypair.secretKey);

  return {
    ...packet,
    signature: {
      algorithm: "ed25519",
      publicKey: keypair.publicKey.toBase58(),
      packetHash,
      signedPayload: `sha256:${packetHash}`,
      signatureBase64: Buffer.from(signatureBytes).toString("base64"),
      signedAt: new Date().toISOString(),
    },
  };
}

function signEd25519(message: Buffer, solanaSecretKey: Uint8Array): Buffer {
  const seed = Buffer.from(solanaSecretKey.slice(0, 32));
  const pkcs8Prefix = Buffer.from("302e020100300506032b657004220420", "hex");
  const privateKey = createPrivateKey({
    key: Buffer.concat([pkcs8Prefix, seed]),
    format: "der",
    type: "pkcs8",
  });
  return cryptoSign(null, message, privateKey);
}

async function publishPublicProofPacket(packet: ExecutionProofPacket): Promise<Record<string, string | null>> {
  packet = normalizeProofPacket(packet);
  const publicDir = resolve("public/proofs");
  await mkdir(publicDir, { recursive: true });

  const latestJsonPath = resolve(publicDir, "latest.json");
  const proofJsonPath = resolve(publicDir, `${packet.proofPacketId}.json`);
  const ledgerJsonPath = resolve(publicDir, "ledger.json");
  const latestCardPath = resolve(publicDir, "latest-card.png");
  const proofCardPath = resolve(publicDir, `${packet.proofPacketId}-card.png`);
  const latestSvgCardPath = resolve(publicDir, "latest-card.svg");
  const proofSvgCardPath = resolve(publicDir, `${packet.proofPacketId}-card.svg`);
  const cardSourcePath = packet.artifacts.proofCardPath ? resolve(packet.artifacts.proofCardPath) : null;

  await writeFile(latestJsonPath, `${JSON.stringify(packet, null, 2)}\n`, "utf8");
  await writeFile(proofJsonPath, `${JSON.stringify(packet, null, 2)}\n`, "utf8");

  let publicCardUrl: string | null = null;
  if (packet.artifacts.proofCardPath?.startsWith("https://")) {
    publicCardUrl = await pinRemoteProofCard(packet.artifacts.proofCardPath, latestCardPath, proofCardPath);
  } else if (packet.artifacts.proofCardPath?.startsWith("/proofs/")) {
    publicCardUrl = packet.artifacts.proofCardPath;
    try {
      await copyFile(resolve("public", packet.artifacts.proofCardPath.replace(/^\//, "")), latestCardPath);
    } catch {
      publicCardUrl = packet.artifacts.proofCardPath;
    }
  } else if (cardSourcePath?.endsWith(".png")) {
    try {
      await copyFile(cardSourcePath, latestCardPath);
      await copyFile(cardSourcePath, proofCardPath);
      publicCardUrl = `/proofs/${packet.proofPacketId}-card.png`;
    } catch {
      publicCardUrl = null;
    }
  } else {
    const svg = buildProofCardSvg(packet);
    await writeFile(latestSvgCardPath, svg, "utf8");
    await writeFile(proofSvgCardPath, svg, "utf8");
    publicCardUrl = `/proofs/${packet.proofPacketId}-card.svg`;
  }

  await updateProofLedger(ledgerJsonPath, packet, publicCardUrl);

  return {
    ledger: "/proofs",
    ledgerJson: "/proofs/ledger.json",
    latestJson: "/proofs/latest.json",
    proofJson: `/proofs/${packet.proofPacketId}.json`,
    latestHtml: "/live",
    proofHtml: `/proofs/${packet.proofPacketId}`,
    latestCard: publicCardUrl,
    proofCard: publicCardUrl,
  };
}

async function localizePacketProofCard(packet: ExecutionProofPacket): Promise<ExecutionProofPacket> {
  const proofCardPath = packet.artifacts.proofCardPath;
  if (!proofCardPath?.startsWith("https://")) {
    return packet;
  }

  const publicDir = resolve("public/proofs");
  await mkdir(publicDir, { recursive: true });
  const localCardPath = resolve(publicDir, `${packet.proofPacketId}-card.png`);
  const publicCardUrl = await pinRemoteProofCard(proofCardPath, resolve(publicDir, "latest-card.png"), localCardPath);
  await preservePinnedProofCard(packet.auditJob.auditJobId, localCardPath, publicCardUrl);

  return {
    ...packet,
    artifacts: {
      ...packet.artifacts,
      proofCardPath: publicCardUrl,
    },
  };
}

async function preservePinnedProofCard(auditJobId: string, localCardPath: string, publicCardUrl: string): Promise<void> {
  if (!publicCardUrl.startsWith("/proofs/")) {
    return;
  }

  try {
    const artifactCardPath = resolve("data/artifacts", auditJobId, "proof-card.png");
    await mkdir(dirname(artifactCardPath), { recursive: true });
    await copyFile(localCardPath, artifactCardPath);
  } catch {
    // Public proof publishing is the source of truth; artifact copy failure should not fail the audit.
  }
}

async function pinRemoteProofCard(url: string, latestCardPath: string, proofCardPath: string): Promise<string> {
  try {
    const response = await fetch(url);
    if (!response.ok) {
      throw new Error(`proof card fetch returned ${response.status}`);
    }

    const contentType = response.headers.get("content-type") ?? "";
    if (!contentType.includes("image/")) {
      throw new Error(`proof card fetch returned ${contentType || "unknown content type"}`);
    }

    const bytes = Buffer.from(await response.arrayBuffer());
    await writeFile(latestCardPath, bytes);
    await writeFile(proofCardPath, bytes);
    return `/proofs/${proofCardPath.split("/").pop()}`;
  } catch {
    return url;
  }
}

function buildProofCardSvg(packet: ExecutionProofPacket): string {
  const width = 1200;
  const height = 675;
  const title = shortCardText(packet.targetAgent.name, 34);
  const verdict = packet.scores.verdict.toUpperCase();
  const score = String(packet.scores.overall);
  const services = packet.aceAnalysis.servicesUsed.slice(0, 3).join(" / ") || "none";
  const paymentSummary = ledgerPaymentSummary(packet);
  const risks = packet.riskFlags.slice(0, 4).join(" / ") || "none";
  const created = packet.createdAt.slice(0, 10);
  const hash = packet.signature?.packetHash?.slice(0, 20) ?? "unsigned";

  return `<?xml version="1.0" encoding="UTF-8"?>
<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}" role="img" aria-label="Proofline execution proof card">
  <rect width="1200" height="675" fill="#101215"/>
  <rect x="36" y="36" width="1128" height="603" rx="18" fill="#17191c" stroke="#4d4637" stroke-width="2"/>
  <text x="72" y="96" fill="#ffe08d" font-family="monospace" font-size="24" font-weight="700">PROOFLINE EXECUTION PROOF</text>
  <text x="72" y="154" fill="#e3e2e5" font-family="Arial, sans-serif" font-size="48" font-weight="700">${escapeSvg(title)}</text>
  <text x="72" y="206" fill="#cac6bd" font-family="monospace" font-size="20">Proof ID ${escapeSvg(packet.proofPacketId)} / ${escapeSvg(created)}</text>
  <rect x="72" y="254" width="270" height="160" rx="12" fill="#1f2022" stroke="#4d4637"/>
  <text x="96" y="302" fill="#cac6bd" font-family="monospace" font-size="18">VERDICT</text>
  <text x="96" y="360" fill="#ffdf8a" font-family="Arial, sans-serif" font-size="40" font-weight="700">${escapeSvg(verdict)}</text>
  <rect x="378" y="254" width="210" height="160" rx="12" fill="#1f2022" stroke="#4d4637"/>
  <text x="402" y="302" fill="#cac6bd" font-family="monospace" font-size="18">SCORE</text>
  <text x="402" y="370" fill="#e3e2e5" font-family="Arial, sans-serif" font-size="72" font-weight="700">${escapeSvg(score)}</text>
  <text x="510" y="370" fill="#cac6bd" font-family="monospace" font-size="24">/100</text>
  <rect x="624" y="254" width="468" height="160" rx="12" fill="#1f2022" stroke="#4d4637"/>
  <text x="648" y="302" fill="#cac6bd" font-family="monospace" font-size="18">PAYMENT</text>
  <text x="648" y="350" fill="#e3e2e5" font-family="Arial, sans-serif" font-size="30" font-weight="700">${escapeSvg(paymentSummary.status)}</text>
  <text x="648" y="388" fill="#cac6bd" font-family="monospace" font-size="18">Ace ${escapeSvg(String(paymentSummary.acePaymentTotalUsdc))} USDC</text>
  <text x="72" y="480" fill="#cac6bd" font-family="monospace" font-size="20">ACE SERVICES</text>
  <text x="72" y="522" fill="#e3e2e5" font-family="Arial, sans-serif" font-size="28">${escapeSvg(services)}</text>
  <text x="72" y="580" fill="#cac6bd" font-family="monospace" font-size="20">RISKS</text>
  <text x="72" y="616" fill="#e3e2e5" font-family="Arial, sans-serif" font-size="24">${escapeSvg(shortCardText(risks, 78))}</text>
  <text x="812" y="616" fill="#8f918f" font-family="monospace" font-size="18">sha256:${escapeSvg(hash)}</text>
</svg>
`;
}

async function rebuildPublicProofsFromStoredPackets(keypairPath: string): Promise<Record<string, string | null | number>> {
  const packetsDir = resolve("data/proof-packets");
  const publicDir = resolve("public/proofs");
  await mkdir(publicDir, { recursive: true });
  await writeFile(resolve(publicDir, "ledger.json"), "[]\n", "utf8");

  const packetFiles = (await readdir(packetsDir))
    .filter((file) => file.startsWith("proof_") && file.endsWith(".json"))
    .sort();
  const packets = [];

  for (const file of packetFiles) {
    const packetPath = resolve(packetsDir, file);
    const packet = await finalizeProofPacket(
      await localizePacketProofCard(normalizeProofPacket(JSON.parse(await readFile(packetPath, "utf8")) as ExecutionProofPacket)),
      keypairPath,
    );
    assertProofPacket(packet);
    await writeFile(packetPath, `${JSON.stringify(packet, null, 2)}\n`, "utf8");
    packets.push(packet);
  }

  packets.sort((a, b) => new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime());

  let latest: Record<string, string | null> = {
    ledger: "/proofs/",
    ledgerJson: "/proofs/ledger.json",
    latestJson: null,
    proofJson: null,
    latestHtml: null,
    proofHtml: null,
    latestCard: null,
    proofCard: null,
  };

  for (const packet of packets) {
    latest = await publishPublicProofPacket(packet);
  }

  return {
    ...latest,
    packetCount: packets.length,
  };
}

function normalizeProofPacket(packet: ExecutionProofPacket): ExecutionProofPacket {
  return {
    ...packet,
    auditStatus: packet.auditStatus ?? packet.auditJob.status,
  };
}

interface ProofLedgerEntry {
  proofPacketId: string;
  targetName: string;
  targetAgentId: string;
  toolName: string;
  category: string;
  auditStatus: string;
  verdict: string;
  overallScore: number;
  riskFlags: string[];
  riskLevel: string;
  aceServicesUsed: string[];
  paymentStatus: string;
  paymentMethod: string;
  paymentIntegrity: string;
  acePaymentTotalUsdc?: number;
  createdAt: string;
  packetHash: string | null;
  proofHtml: string;
  proofJson: string;
  proofCard: string | null;
}

async function updateProofLedger(
  ledgerPath: string,
  packet: ExecutionProofPacket,
  cardUrl: string | null,
): Promise<ProofLedgerEntry[]> {
  const current = await readProofLedger(ledgerPath);
  const paymentSummary = ledgerPaymentSummary(packet);
  const entry: ProofLedgerEntry = {
    proofPacketId: packet.proofPacketId,
    targetName: packet.targetAgent.name,
    targetAgentId: packet.targetAgent.agentId,
    toolName: packet.targetAgent.toolName,
    category: packet.targetAgent.category,
    auditStatus: packet.auditStatus,
    verdict: packet.scores.verdict,
    overallScore: packet.scores.overall,
    riskFlags: packet.riskFlags,
    riskLevel: ledgerRiskLevel(packet),
    aceServicesUsed: packet.aceAnalysis.servicesUsed,
    paymentStatus: paymentSummary.status,
    paymentMethod: paymentSummary.method,
    paymentIntegrity: ledgerPaymentIntegrity(packet),
    ...(paymentSummary.acePaymentTotalUsdc > 0 ? { acePaymentTotalUsdc: paymentSummary.acePaymentTotalUsdc } : {}),
    createdAt: packet.createdAt,
    packetHash: packet.signature?.packetHash ?? null,
    proofHtml: `/proofs/${packet.proofPacketId}`,
    proofJson: `/proofs/${packet.proofPacketId}.json`,
    proofCard: cardUrl,
  };
  const ledger = [entry, ...current.filter((item) => item.proofPacketId !== packet.proofPacketId)].slice(0, 100);
  await writeFile(ledgerPath, `${JSON.stringify(ledger, null, 2)}\n`, "utf8");
  return ledger;
}

function ledgerRiskLevel(packet: ExecutionProofPacket): string {
  if (packet.scores.verdict === "failed" || packet.riskFlags.length >= 3) return "high";
  if (packet.scores.verdict === "warning" || packet.riskFlags.length > 0) return "medium";
  return "low";
}

function ledgerPaymentIntegrity(packet: ExecutionProofPacket): string {
  const targetPayment = packet.payments.find((payment) => payment.provider !== "ace_data_cloud");
  const acePayments = packet.payments.filter((payment) => payment.provider === "ace_data_cloud");
  const settledAcePayments = acePayments.filter((payment) => payment.status === "settled");

  if (targetPayment?.status === "settled" && targetPayment.transactionHash) return "target_settled_with_hash";
  if (targetPayment?.status === "settled") return "target_settled";
  if (targetPayment?.status === "failed") return "target_payment_failed";
  if (settledAcePayments.length > 0 && targetPayment?.status === "skipped") return "ace_x402_settled_target_skipped";
  if (settledAcePayments.length > 0) return "ace_x402_settled";
  if (targetPayment?.status === "skipped") return "skipped_no_spend";
  return "unverified";
}

function ledgerPaymentSummary(packet: ExecutionProofPacket): { status: string; method: string; acePaymentTotalUsdc: number } {
  const targetPayment = packet.payments.find((payment) => payment.provider !== "ace_data_cloud");
  const acePayments = packet.payments.filter((payment) => payment.provider === "ace_data_cloud");
  const settledAcePayments = acePayments.filter((payment) => payment.status === "settled");
  const failedPayments = packet.payments.filter((payment) => payment.status === "failed");
  const acePaymentTotalUsdc = settledAcePayments.reduce((sum, payment) => {
    const amount = Number(payment.amount);
    return Number.isFinite(amount) ? sum + amount : sum;
  }, 0);

  const status =
    failedPayments.length > 0
      ? "failed"
      : settledAcePayments.length > 0 && targetPayment?.status === "skipped"
        ? "ace_settled_target_skipped"
        : settledAcePayments.length > 0
          ? "settled"
          : targetPayment?.status ?? "unknown";

  const methods = [...new Set(packet.payments.map((payment) => `${payment.provider}:${payment.method}`))];
  return {
    status,
    method: methods.length > 0 ? methods.join(",") : "unknown",
    acePaymentTotalUsdc: Number(acePaymentTotalUsdc.toFixed(6)),
  };
}

async function readProofLedger(ledgerPath: string): Promise<ProofLedgerEntry[]> {
  try {
    const raw = await readFile(ledgerPath, "utf8");
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed)) return [];
    return parsed.filter(isProofLedgerEntry);
  } catch {
    return [];
  }
}

function isProofLedgerEntry(value: unknown): value is ProofLedgerEntry {
  return isRecord(value) && typeof value.proofPacketId === "string";
}

function prooflinePageHead(title: string): string {
  return `<head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>${escapeHtml(title)}</title>
    <link rel="icon" href="/proofline.png" />
    <link href="https://fonts.googleapis.com" rel="preconnect" />
    <link crossorigin="" href="https://fonts.gstatic.com" rel="preconnect" />
    <link href="https://fonts.googleapis.com/css2?family=Geist+Mono:wght@400;500;600&family=Geist:wght@400;500;600&display=swap" rel="stylesheet" />
    <link href="https://fonts.googleapis.com/css2?family=Material+Symbols+Outlined:wght,FILL@100..700,0..1&display=swap" rel="stylesheet" />
    <script src="https://cdn.tailwindcss.com?plugins=forms,container-queries"></script>
    <script>
      tailwind.config = {
        darkMode: "class",
        theme: {
          extend: {
            colors: {
              "on-primary-fixed-variant": "#584400",
              "on-surface": "#e3e2e5",
              "inverse-surface": "#e3e2e5",
              "tertiary-fixed-dim": "#bbc3ff",
              "primary-fixed": "#ffe08d",
              "outline-variant": "#4d4637",
              "surface-container": "#1f2022",
              "inverse-primary": "#745b00",
              "on-secondary-fixed-variant": "#484740",
              "secondary-fixed": "#e6e2d8",
              "error-container": "#93000a",
              "on-tertiary-fixed-variant": "#38427e",
              "surface-container-highest": "#343537",
              "on-background": "#e3e2e5",
              "on-error": "#690005",
              "error": "#ffb4ab",
              "on-tertiary": "#202b66",
              "on-primary-fixed": "#241a00",
              "surface-dim": "#121315",
              "surface-variant": "#343537",
              "secondary-fixed-dim": "#cac6bd",
              "on-primary-container": "#5c4800",
              "on-tertiary-container": "#3b4681",
              "secondary-container": "#484740",
              "tertiary": "#ced3ff",
              "tertiary-container": "#acb6fa",
              "on-surface-variant": "#d0c5b2",
              "primary-fixed-dim": "#e5c365",
              "tertiary-fixed": "#dee0ff",
              "surface-container-high": "#292a2c",
              "surface-tint": "#e5c365",
              "surface-container-low": "#1b1c1e",
              "surface-bright": "#38393b",
              "on-secondary-fixed": "#1c1c16",
              "secondary": "#cac6bd",
              "surface-container-lowest": "#0d0e10",
              "background": "#121315",
              "primary-container": "#d8b75a",
              "on-secondary-container": "#b8b5ac",
              "on-secondary": "#31312a",
              "inverse-on-surface": "#303033",
              "primary": "#f6d372",
              "on-primary": "#3d2f00",
              "surface": "#121315",
              "on-tertiary-fixed": "#081450",
              "on-error-container": "#ffdad6",
              "outline": "#98907e"
            },
            borderRadius: {
              DEFAULT: "0.125rem",
              lg: "0.25rem",
              xl: "0.5rem",
              full: "0.75rem"
            },
            spacing: {
              "panel-gap": "1px",
              "container-padding": "24px",
              unit: "4px",
              "stack-sm": "8px",
              "stack-md": "16px",
              gutter: "16px"
            },
            fontFamily: {
              "body-sm": ["Geist", "sans-serif"],
              "body-lg": ["Geist", "sans-serif"],
              "display-lg": ["Geist", "sans-serif"],
              "headline-sm": ["Geist", "sans-serif"],
              "headline-md": ["Geist", "sans-serif"],
              "body-md": ["Geist", "sans-serif"],
              "mono-data": ["Geist Mono", "monospace"],
              "mono-label": ["Geist Mono", "monospace"]
            },
            fontSize: {
              "body-sm": ["13px", { lineHeight: "18px", fontWeight: "400" }],
              "body-lg": ["16px", { lineHeight: "24px", fontWeight: "400" }],
              "display-lg": ["40px", { lineHeight: "48px", letterSpacing: "-0.02em", fontWeight: "600" }],
              "headline-sm": ["18px", { lineHeight: "24px", fontWeight: "500" }],
              "headline-md": ["24px", { lineHeight: "32px", letterSpacing: "-0.01em", fontWeight: "500" }],
              "body-md": ["14px", { lineHeight: "20px", fontWeight: "400" }],
              "mono-data": ["13px", { lineHeight: "20px", fontWeight: "400" }],
              "mono-label": ["12px", { lineHeight: "16px", letterSpacing: "0.05em", fontWeight: "500" }]
            }
          }
        }
      };
    </script>
    <style>
      .material-symbols-outlined { font-variation-settings: 'FILL' 0, 'wght' 300, 'GRAD' 0, 'opsz' 24; }
      .material-icon-filled { font-variation-settings: 'FILL' 1, 'wght' 400, 'GRAD' 0, 'opsz' 24; }
      ::-webkit-scrollbar { width: 6px; height: 6px; }
      ::-webkit-scrollbar-track { background: transparent; }
      ::-webkit-scrollbar-thumb { background: #343537; border-radius: 3px; }
      ::-webkit-scrollbar-thumb:hover { background: #4d4637; }
    </style>
  </head>`;
}

function prooflineHeader(active: "ledger" | "proof"): string {
  const ledgerClass =
    active === "ledger"
      ? "text-primary border-b-2 border-primary pb-1"
      : "text-on-surface-variant hover:text-primary pb-[6px]";
  const proofClass =
    active === "proof"
      ? "text-primary border-b-2 border-primary pb-1"
      : "text-on-surface-variant hover:text-primary pb-[6px]";
  return `<header class="flex justify-between items-center w-full px-container-padding h-16 sticky top-0 z-50 bg-surface border-b border-outline-variant">
      <div class="flex items-center gap-8">
        <a class="flex items-center gap-3" href="/proofs/">
          <img src="/proofline.png" alt="Proofline" class="h-9 w-9 rounded-lg object-cover border border-outline-variant" />
          <div class="font-headline-md text-headline-md font-bold tracking-tighter text-primary">Proofline</div>
        </a>
        <nav class="hidden md:flex gap-6 h-full items-end">
          <a class="font-headline-sm text-headline-sm md:font-body-md md:text-body-md ${ledgerClass} transition-colors duration-200" href="/proofs/">Evidence Ledger</a>
          <a class="font-headline-sm text-headline-sm md:font-body-md md:text-body-md ${proofClass} transition-colors duration-200" href="/proofs/latest.html">Proof JSON</a>
          <a class="font-headline-sm text-headline-sm md:font-body-md md:text-body-md text-on-surface-variant transition-colors duration-200 hover:text-primary pb-[6px]" href="/agent.json">SAP Agent</a>
        </nav>
      </div>
    </header>`;
}

function verdictClass(verdict: string): string {
  const normalized = verdict.toLowerCase();
  if (normalized.includes("deliver") || normalized.includes("verified")) return "bg-[#55F08A]/10 text-[#55F08A]";
  if (normalized.includes("fail")) return "bg-error-container/30 text-error";
  return "bg-[#f6d372]/10 text-[#f6d372]";
}

function paymentTone(status: string): string {
  const normalized = status.toLowerCase();
  if (normalized.includes("settled") || normalized.includes("paid")) return "text-[#55F08A]";
  if (normalized.includes("failed")) return "text-error";
  return "text-[#f6d372]";
}

function formatProofDate(value: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return new Intl.DateTimeFormat("en", { month: "short", day: "2-digit", year: "numeric" }).format(date);
}

function shortProofId(value: string): string {
  return value.length > 18 ? `${value.slice(0, 10)}...${value.slice(-6)}` : value;
}

function scoreBar(label: string, score: number): string {
  const bounded = Math.max(0, Math.min(100, Math.round(score)));
  return `<div class="flex flex-col gap-1">
      <div class="flex justify-between items-center w-full">
        <span class="font-mono-label text-mono-label text-on-surface-variant">${escapeHtml(label)}</span>
        <span class="font-mono-data text-mono-data text-on-surface">${bounded}</span>
      </div>
      <div class="w-full h-unit bg-surface-variant rounded-full overflow-hidden">
        <div class="h-full bg-primary-container" style="width: ${bounded}%"></div>
      </div>
    </div>`;
}

function ledgerVerdictBadge(verdict: string): string {
  const normalized = verdict.toLowerCase();
  const label = normalized === "delivered" ? "Verified" : verdict;
  const dot = normalized.includes("fail") ? "bg-error" : normalized.includes("deliver") ? "bg-[#55F08A]" : "bg-[#f6d372]";
  const extra = normalized.includes("fail")
    ? `<span class="text-[10px] uppercase tracking-wide text-error">Review Needed</span>`
    : normalized.includes("warning") || normalized.includes("audit")
      ? `<span class="text-[10px] uppercase tracking-wide text-error">Risk flags</span>`
      : "";
  return `<div class="flex flex-col gap-1 items-start">
      <span class="inline-flex items-center gap-1.5 px-2 py-0.5 rounded-full ${verdictClass(verdict)} font-mono-label text-mono-label">
        <span class="w-1.5 h-1.5 rounded-full ${dot}"></span>${escapeHtml(label)}
      </span>${extra}
    </div>`;
}

function buildLedgerPageHtml(entries: ProofLedgerEntry[]): string {
  const latest = entries[0];
  const totalProofs = entries.length;
  const latestScore = latest ? latest.overallScore.toString() : "0";
  const serviceCount = new Set(entries.flatMap((entry) => entry.aceServicesUsed)).size;
  const rows = entries
    .map(
      (entry) => `<tr class="proof-ledger-row border-b border-outline-variant hover:bg-surface-container-high transition-colors" data-verdict="${escapeHtml(entry.verdict)}" data-payment="${escapeHtml(entry.paymentStatus)}" data-risk="${escapeHtml(entry.riskFlags.length >= 2 ? "high" : "normal")}">
        <td class="py-3 px-4">
          <a class="text-primary hover:underline" href="${escapeHtml(entry.proofHtml)}">${escapeHtml(shortProofId(entry.proofPacketId))}</a>
        </td>
        <td class="py-3 px-4 text-on-surface">${escapeHtml(entry.targetName)}</td>
        <td class="py-3 px-4">
          ${ledgerVerdictBadge(entry.verdict)}
        </td>
        <td class="py-3 px-4 text-on-surface">${entry.overallScore}/100</td>
        <td class="py-3 px-4 ${paymentTone(entry.paymentStatus)}">${escapeHtml(entry.paymentStatus)}</td>
        <td class="py-3 px-4 text-on-surface-variant">${escapeHtml(entry.aceServicesUsed.length.toString())}</td>
        <td class="py-3 px-4 text-on-surface-variant">${escapeHtml(formatProofDate(entry.createdAt))}</td>
        <td class="py-3 px-4 text-right">
          <div class="flex items-center justify-end gap-3 text-on-surface-variant">
            <a class="hover:text-primary transition-colors" href="${escapeHtml(entry.proofHtml)}" title="View Proof"><span class="material-symbols-outlined text-[18px]">visibility</span></a>
            <a class="hover:text-primary transition-colors" href="${escapeHtml(entry.proofJson)}" title="JSON"><span class="material-symbols-outlined text-[18px]">data_object</span></a>
            ${entry.proofCard ? `<a class="hover:text-primary transition-colors" href="${escapeHtml(entry.proofCard)}" title="Card"><span class="material-symbols-outlined text-[18px]">branding_watermark</span></a>` : ""}
          </div>
        </td>
      </tr>`,
    )
    .join("\n");

  return `<!doctype html>
<html lang="en" class="dark">
  ${prooflinePageHead("Proofline Evidence Ledger")}
  <body class="bg-surface text-on-surface antialiased min-h-screen flex flex-col">
    ${prooflineHeader("ledger")}
    <main class="flex-grow w-full max-w-[1180px] mx-auto px-container-padding py-8 flex flex-col gap-8">
      <section>
        <h1 class="font-display-lg text-display-lg text-on-surface mb-2">Evidence Ledger</h1>
        <p class="font-body-lg text-body-lg text-on-surface-variant">Signed audit records generated by Proofline.</p>
      </section>

      <section class="grid grid-cols-1 md:grid-cols-3 gap-gutter">
        <div class="bg-surface-container-low border border-outline-variant rounded-xl p-4 flex flex-col justify-between h-24">
          <div class="flex items-center gap-2 text-on-surface-variant font-mono-label text-mono-label uppercase tracking-wider">
            <span class="material-symbols-outlined text-[16px]">file_copy</span>Total Proofs
          </div>
          <div class="font-headline-md text-headline-md text-on-surface">${totalProofs}</div>
        </div>
        <div class="bg-surface-container-low border border-outline-variant rounded-xl p-4 flex flex-col justify-between h-24">
          <div class="flex items-center gap-2 text-on-surface-variant font-mono-label text-mono-label uppercase tracking-wider">
            <span class="material-symbols-outlined text-[16px]">shield</span>Latest Overall Score
          </div>
          <div class="font-headline-md text-headline-md text-on-surface">${escapeHtml(latestScore)}/100</div>
        </div>
        <div class="bg-surface-container-low border border-outline-variant rounded-xl p-4 flex flex-col justify-between h-24">
          <div class="flex items-center gap-2 text-on-surface-variant font-mono-label text-mono-label uppercase tracking-wider">
            <span class="material-symbols-outlined text-[16px]">search_activity</span>Ace Services Used
          </div>
          <div class="font-headline-md text-headline-md text-on-surface">${serviceCount} active</div>
        </div>
      </section>

      <section class="flex flex-wrap gap-2" aria-label="Ledger filters">
        <button data-filter="all" class="ledger-filter font-body-sm text-body-sm px-3 py-1.5 rounded-lg border border-outline-variant bg-surface-container-high text-on-surface hover:bg-surface-container-highest transition-colors">All</button>
        <button data-filter="delivered" class="ledger-filter font-body-sm text-body-sm px-3 py-1.5 rounded-lg border border-outline-variant bg-surface text-on-surface-variant hover:bg-surface-container-low transition-colors">Delivered</button>
        <button data-filter="warning" class="ledger-filter font-body-sm text-body-sm px-3 py-1.5 rounded-lg border border-outline-variant bg-surface text-on-surface-variant hover:bg-surface-container-low transition-colors">Warning</button>
        <button data-filter="failed" class="ledger-filter font-body-sm text-body-sm px-3 py-1.5 rounded-lg border border-outline-variant bg-surface text-on-surface-variant hover:bg-surface-container-low transition-colors">Failed</button>
        <button data-filter="payment-skipped" class="ledger-filter font-body-sm text-body-sm px-3 py-1.5 rounded-lg border border-outline-variant bg-surface text-on-surface-variant hover:bg-surface-container-low transition-colors">Payment Skipped</button>
        <button data-filter="high-risk" class="ledger-filter font-body-sm text-body-sm px-3 py-1.5 rounded-lg border border-outline-variant bg-surface text-on-surface-variant hover:bg-surface-container-low transition-colors">High Risk</button>
      </section>

      <section class="border border-outline-variant rounded-xl overflow-hidden bg-surface-container-low">
        <div class="overflow-x-auto">
          <table class="w-full text-left border-collapse">
            <thead>
              <tr class="border-b border-outline-variant bg-surface-container">
                <th class="py-3 px-4 font-mono-label text-mono-label text-on-surface-variant uppercase tracking-wider font-normal">Proof ID</th>
                <th class="py-3 px-4 font-mono-label text-mono-label text-on-surface-variant uppercase tracking-wider font-normal">Target Agent</th>
                <th class="py-3 px-4 font-mono-label text-mono-label text-on-surface-variant uppercase tracking-wider font-normal">Verdict</th>
                <th class="py-3 px-4 font-mono-label text-mono-label text-on-surface-variant uppercase tracking-wider font-normal">Score</th>
                <th class="py-3 px-4 font-mono-label text-mono-label text-on-surface-variant uppercase tracking-wider font-normal">Payment Status</th>
                <th class="py-3 px-4 font-mono-label text-mono-label text-on-surface-variant uppercase tracking-wider font-normal">Services</th>
                <th class="py-3 px-4 font-mono-label text-mono-label text-on-surface-variant uppercase tracking-wider font-normal">Created Date</th>
                <th class="py-3 px-4 font-mono-label text-mono-label text-on-surface-variant uppercase tracking-wider font-normal text-right">Actions</th>
              </tr>
            </thead>
            <tbody class="font-mono-data text-mono-data">
              ${rows || `<tr><td class="py-6 px-4 text-on-surface-variant" colspan="8">No proofs published yet.</td></tr>`}
            </tbody>
          </table>
        </div>
      </section>
    </main>
    <script>
      const buttons = Array.from(document.querySelectorAll(".ledger-filter"));
      const rows = Array.from(document.querySelectorAll(".proof-ledger-row"));
      const activeClasses = ["bg-surface-container-high", "text-on-surface"];
      const inactiveClasses = ["bg-surface", "text-on-surface-variant"];
      function matches(row, filter) {
        const verdict = row.dataset.verdict || "";
        const payment = row.dataset.payment || "";
        const risk = row.dataset.risk || "";
        if (filter === "all") return true;
        if (filter === "payment-skipped") return payment === "skipped";
        if (filter === "high-risk") return risk === "high";
        return verdict === filter;
      }
      buttons.forEach((button) => {
        button.addEventListener("click", () => {
          const filter = button.dataset.filter || "all";
          buttons.forEach((item) => {
            item.classList.remove(...activeClasses);
            item.classList.add(...inactiveClasses);
          });
          button.classList.remove(...inactiveClasses);
          button.classList.add(...activeClasses);
          rows.forEach((row) => {
            row.hidden = !matches(row, filter);
          });
        });
      });
    </script>
  </body>
</html>
`;
}

function buildProofPageHtml(packet: ExecutionProofPacket, cardUrl: string | null): string {
  const payment = packet.payments[0];
  const paymentRows =
    packet.payments.length > 0
      ? packet.payments
          .map((item) => {
            const proof = item.transactionHash ?? item.receipt ?? item.paymentId;
            return `<div class="border border-outline-variant rounded p-3 flex flex-col gap-2 bg-surface-container-low">
                <div class="flex justify-between items-center gap-3"><span class="font-mono-label text-mono-label text-on-surface-variant uppercase">${escapeHtml(item.provider)}</span><span class="${paymentTone(item.status)} font-mono-label text-mono-label">${escapeHtml(item.status)}</span></div>
                <div class="flex justify-between items-center gap-3"><span class="font-mono-label text-mono-label text-on-surface-variant uppercase">${escapeHtml(item.method)}</span><span class="font-mono-data text-mono-data text-on-surface">${escapeHtml(`${item.amount} ${item.currency}`)}</span></div>
                <div class="font-mono-data text-mono-data text-primary-container truncate">${escapeHtml(proof)}</div>
              </div>`;
          })
          .join("")
      : `<div class="font-body-md text-body-md text-on-surface-variant">No payment receipts recorded.</div>`;
  const serviceChips =
    packet.aceAnalysis.servicesUsed.length > 0
      ? packet.aceAnalysis.servicesUsed
          .map(
            (service) => `<span class="px-2 py-1 border border-outline-variant rounded bg-surface-dim font-mono-label text-mono-label text-on-surface-variant flex items-center gap-1">
                ${escapeHtml(service)} <span class="text-on-surface">used</span>
              </span>`,
          )
          .join("")
      : `<span class="px-2 py-1 border border-outline-variant rounded bg-surface-dim font-mono-label text-mono-label text-on-surface-variant">none</span>`;
  const signature = packet.signature;
  const paymentProof = payment?.transactionHash ?? payment?.receipt ?? payment?.paymentId;
  const signedStatus = signature ? "Cryptographically Signed" : "Unsigned";
  const badgeLabel = packet.scores.verdict === "delivered" ? "VERIFIED" : packet.scores.verdict.toUpperCase();

  return `<!doctype html>
<html lang="en" class="dark">
  ${prooflinePageHead(`Proofline Proof Packet ${packet.proofPacketId}`)}
  <body class="bg-surface-container-lowest text-on-surface antialiased font-body-md min-h-screen flex flex-col">
    ${prooflineHeader("proof")}
    <main class="flex-grow w-full max-w-[1180px] mx-auto pt-stack-md pb-12 px-container-padding">
      <div class="mb-gutter flex flex-col md:flex-row justify-between items-start md:items-end gap-stack-sm">
        <div>
          <h1 class="font-display-lg text-display-lg text-on-surface m-0">Proof ID #${escapeHtml(shortProofId(packet.proofPacketId))}</h1>
          <p class="font-mono-data text-mono-data text-on-surface-variant mt-1">Target: ${escapeHtml(packet.targetAgent.name)}</p>
        </div>
      </div>

      <div class="flex flex-col-reverse md:grid md:grid-cols-12 gap-gutter">
        <div class="md:col-span-7 lg:col-span-8 flex flex-col gap-stack-md">
          <div class="bg-surface border border-outline-variant rounded-lg p-stack-md flex flex-col gap-stack-md">
            <div class="flex justify-between items-center pb-stack-sm border-b border-surface-variant">
              <h2 class="font-headline-sm text-headline-sm text-on-surface">Execution Proof Packet</h2>
              <div class="px-2 py-1 rounded font-mono-label text-mono-label flex items-center gap-1 border border-[#55F08A]/20 ${verdictClass(packet.scores.verdict)}">
                <span class="material-symbols-outlined text-[14px]">verified_user</span>${escapeHtml(badgeLabel)}
              </div>
            </div>
            <div class="grid grid-cols-1 sm:grid-cols-2 gap-stack-md">
              <div class="flex flex-col gap-1">
                <span class="font-mono-label text-mono-label text-on-surface-variant uppercase">Target</span>
                <span class="font-body-md text-body-md text-on-surface">${escapeHtml(packet.targetAgent.name)}</span>
              </div>
              <div class="flex flex-col gap-1">
                <span class="font-mono-label text-mono-label text-on-surface-variant uppercase">Score</span>
                <span class="font-body-md text-body-md text-primary-container">${packet.scores.overall} / 100</span>
              </div>
              <div class="flex flex-col gap-1">
                <span class="font-mono-label text-mono-label text-on-surface-variant uppercase">Created</span>
                <span class="font-body-md text-body-md text-on-surface">${escapeHtml(formatProofDate(packet.createdAt))}</span>
              </div>
              <div class="flex flex-col gap-1">
                <span class="font-mono-label text-mono-label text-on-surface-variant uppercase">Status</span>
                <span class="font-body-md text-body-md text-on-surface">${escapeHtml(signedStatus)}</span>
              </div>
            </div>
          </div>

          <div class="bg-surface border border-outline-variant rounded-lg p-stack-md flex flex-col gap-stack-md">
            <h2 class="font-headline-sm text-headline-sm text-on-surface pb-stack-sm border-b border-surface-variant">Metrics Breakdown</h2>
            <div class="flex flex-col gap-3">
              ${scoreBar("Reliability", packet.scores.reliability)}
              ${scoreBar("Capability", packet.scores.capabilityMatch)}
              ${scoreBar("Payment Integrity", packet.scores.paymentIntegrity)}
              ${scoreBar("Public Footprint", packet.scores.publicFootprint)}
              ${scoreBar("Safety", packet.scores.safety)}
            </div>
          </div>

          <div class="grid grid-cols-1 md:grid-cols-2 gap-stack-md">
            <div class="bg-surface border border-outline-variant rounded-lg p-stack-md flex flex-col gap-stack-md">
              <h2 class="font-headline-sm text-headline-sm text-on-surface pb-stack-sm border-b border-surface-variant">Verification Timeline</h2>
              <ul class="flex flex-col gap-3">
                <li class="flex items-start gap-2"><span class="material-symbols-outlined text-[16px] text-primary-container mt-[2px] material-icon-filled">check_circle</span><span class="font-body-md text-body-md text-on-surface">Target selected</span></li>
                <li class="flex items-start gap-2"><span class="material-symbols-outlined text-[16px] text-primary-container mt-[2px] material-icon-filled">check_circle</span><span class="font-body-md text-body-md text-on-surface">Sentinel preflight: ${escapeHtml(packet.sentinelCheck.status)}</span></li>
                <li class="flex items-start gap-2"><span class="material-symbols-outlined text-[16px] text-primary-container mt-[2px] material-icon-filled">check_circle</span><span class="font-body-md text-body-md text-on-surface">Probe executed: ${escapeHtml(packet.probeResult.status)}</span></li>
                <li class="flex items-start gap-2"><span class="material-symbols-outlined text-[16px] text-primary-container mt-[2px] material-icon-filled">check_circle</span><span class="font-body-md text-body-md text-on-surface">Ace analysis</span></li>
                <li class="flex items-start gap-2"><span class="material-symbols-outlined text-[16px] text-primary-container mt-[2px] material-icon-filled">check_circle</span><span class="font-body-md text-body-md text-on-surface">Proof signed</span></li>
                <li class="flex items-start gap-2"><span class="material-symbols-outlined text-[16px] text-primary-container mt-[2px] material-icon-filled">check_circle</span><span class="font-body-md text-body-md text-on-surface">Public artifact published</span></li>
              </ul>
            </div>
            <div class="flex flex-col gap-stack-md">
              <div class="bg-surface border border-outline-variant rounded-lg p-stack-md flex flex-col gap-stack-sm">
                <h2 class="font-headline-sm text-headline-sm text-on-surface pb-stack-sm border-b border-surface-variant">Payment Ledger</h2>
                ${paymentRows}
              </div>
              <div class="bg-surface border border-outline-variant rounded-lg p-stack-md flex flex-col gap-stack-sm flex-grow">
                <h2 class="font-headline-sm text-headline-sm text-on-surface pb-stack-sm border-b border-surface-variant">Ace Usage Metrics</h2>
                <div class="flex flex-wrap gap-2 mt-1">${serviceChips}</div>
              </div>
            </div>
          </div>

          <div class="bg-[#101215] border border-outline-variant rounded-lg p-stack-md flex flex-col gap-stack-sm">
            <h2 class="font-headline-sm text-headline-sm text-on-surface pb-stack-sm border-b border-[#242629]">Cryptographic Integrity</h2>
            <div class="grid grid-cols-1 md:grid-cols-3 gap-stack-md mt-2">
              <div class="flex flex-col gap-1 overflow-hidden"><span class="font-mono-label text-mono-label text-on-surface-variant uppercase">Packet Hash</span><div class="flex items-center justify-between bg-surface-container-lowest p-2 border border-[#242629] rounded"><span class="font-mono-data text-mono-data text-on-surface truncate pr-2">${escapeHtml(signature?.packetHash ?? "unsigned")}</span></div></div>
              <div class="flex flex-col gap-1 overflow-hidden"><span class="font-mono-label text-mono-label text-on-surface-variant uppercase">Signature</span><div class="flex items-center justify-between bg-surface-container-lowest p-2 border border-[#242629] rounded"><span class="font-mono-data text-mono-data text-on-surface truncate pr-2">${escapeHtml(signature?.signatureBase64 ?? "unsigned")}</span></div></div>
              <div class="flex flex-col gap-1 overflow-hidden"><span class="font-mono-label text-mono-label text-on-surface-variant uppercase">Signing Wallet</span><div class="flex items-center justify-between bg-surface-container-lowest p-2 border border-[#242629] rounded"><span class="font-mono-data text-mono-data text-on-surface truncate pr-2">${escapeHtml(signature?.publicKey ?? "unknown")}</span></div></div>
            </div>
          </div>
        </div>

        <div class="md:col-span-5 lg:col-span-4 flex flex-col gap-stack-md relative">
          <div class="bg-[#101215] border border-[#242629] rounded-xl p-4 flex flex-col items-center justify-center min-h-[400px] relative overflow-hidden group">
            <div class="absolute inset-0 bg-[radial-gradient(ellipse_at_center,_var(--tw-gradient-stops))] from-primary-container/10 via-background/0 to-transparent pointer-events-none"></div>
            ${cardUrl ? `<img alt="Proofline Execution Proof Packet ${escapeHtml(packet.proofPacketId)}" class="relative z-10 max-w-full h-auto drop-shadow-2xl hover:scale-[1.02] transition-transform duration-500 ease-out" src="${escapeHtml(cardUrl)}" />` : `<div class="relative z-10 text-on-surface-variant">No proof card available</div>`}
          </div>
          <div class="flex flex-col gap-3 w-full">
            ${cardUrl ? `<a class="w-full flex items-center justify-center gap-2 bg-primary-container text-on-primary-container font-mono-label text-mono-label px-4 py-3 rounded uppercase tracking-wider active:scale-[0.98] transition-all hover:bg-primary border border-transparent shadow-[inset_0_1px_0_rgba(255,255,255,0.2)]" href="${escapeHtml(cardUrl)}"><span class="material-symbols-outlined text-[18px]">download</span>Download Card</a>` : ""}
            <div class="grid grid-cols-2 gap-3">
              <a class="w-full flex items-center justify-center gap-2 bg-transparent border border-outline-variant text-on-surface font-mono-label text-mono-label px-4 py-3 rounded uppercase tracking-wider active:scale-[0.98] transition-all hover:bg-surface-variant" href="/proofs/${escapeHtml(packet.proofPacketId)}.json"><span class="material-symbols-outlined text-[18px]">data_object</span>View JSON</a>
              <a class="w-full flex items-center justify-center gap-2 bg-transparent border border-outline-variant text-on-surface font-mono-label text-mono-label px-4 py-3 rounded uppercase tracking-wider active:scale-[0.98] transition-all hover:bg-surface-variant" href="/proofs/"><span class="material-symbols-outlined text-[18px]">account_tree</span>Open Ledger</a>
            </div>
          </div>
        </div>
      </div>
    </main>
  </body>
</html>
`;
}

function stableJson(value: unknown): string {
  return JSON.stringify(sortJson(value));
}

function sortJson(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortJson);
  if (!isRecord(value)) return value;
  return Object.fromEntries(Object.entries(value).sort(([a], [b]) => a.localeCompare(b)).map(([key, item]) => [key, sortJson(item)]));
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function escapeSvg(value: string): string {
  return escapeHtml(value);
}

async function writeJson(path: string, value: unknown): Promise<string> {
  const outputPath = resolve(path);
  await mkdir(dirname(outputPath), { recursive: true });
  await writeFile(outputPath, `${JSON.stringify(value, null, 2)}\n`, "utf8");
  return outputPath;
}

async function writeJsonArtifact(config: ReturnType<typeof loadConfig>, path: string, value: unknown): Promise<string> {
  if (config.storageMode === "supabase") {
    void value;
    return supabaseArtifactRef(path);
  }
  return writeJson(path, value);
}

function supabaseArtifactRef(path: string): string {
  return `supabase:ace_artifacts/${path.replace(/^data\/artifacts\//, "")}`;
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
