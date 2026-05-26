import { createHash, createPrivateKey, randomUUID, sign as cryptoSign } from "node:crypto";
import { copyFile, mkdir, readFile, writeFile } from "node:fs/promises";
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
import {
  AceDataCloudClient,
  extractAceChatContent,
  type AceServiceResult,
} from "../../../packages/integrations/src/index.js";
import { loadConfig, safeConfigSummary } from "./config.js";
import { loadKeypairFromFile } from "./keypair.js";
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

interface AceArtifacts {
  directory: string;
  searchPath?: string;
  translationPath?: string;
  imagePath?: string;
  imageUrl?: string;
  imageResponsePath?: string;
  summaryPath?: string;
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
    ? await runAceAnalysis(auditJobId, target, plannedTarget, sentinelCheck, payment, probeResult, config)
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
  packet = await finalizeProofPacket(packet, config.sapKeypairPath);

  const proofPacketPath = await store.writeProofPacket(packet);
  const publicProof = await publishPublicProofPacket(packet);
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
    publicProof,
    completedAt,
  });

  logger.info("Proofline audit complete", {
    proofPacketId: packet.proofPacketId,
    verdict: packet.scores.verdict,
    overallScore: packet.scores.overall,
    riskFlags,
    paymentStatus: payment.status,
    proofPacketPath,
    publicProof,
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
  config: ReturnType<typeof loadConfig>,
): Promise<AceAnalysisResult> {
  const createdAt = new Date().toISOString();
  const client = new AceDataCloudClient({
    apiKey: config.aceApiKey,
    ...(process.env.ACE_CHAT_MODEL ? { chatModel: process.env.ACE_CHAT_MODEL } : {}),
    ...(process.env.ACE_IMAGE_MODEL ? { imageModel: process.env.ACE_IMAGE_MODEL } : {}),
    timeoutMs: Number(process.env.ACE_TIMEOUT_MS ?? 180000),
  });
  const artifacts: AceArtifacts = {
    directory: resolve("data/artifacts", auditJobId),
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
    artifacts.searchPath = await writeJson(`data/artifacts/${auditJobId}/ace-serp-search.json`, trimAcePayload(search));

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
    artifacts.summaryPath = await writeJson(`data/artifacts/${auditJobId}/ace-analysis.json`, {
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
      const imageArtifacts = await writeImageArtifacts(auditJobId, image);
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
        })),
        artifacts,
        note: "servicesUsed contains only successful Ace Data Cloud service calls.",
      },
      createdAt,
    };
  } catch (error) {
    if (calls.length > 0) {
      await writeJson(`data/artifacts/${auditJobId}/ace-partial-failure.json`, {
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
        })),
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

async function writeTextOrJsonArtifact(path: string, result: AceServiceResult): Promise<string> {
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
  auditJobId: string,
  result: AceServiceResult,
): Promise<{ imagePath?: string; imageUrl?: string; imageResponsePath: string }> {
  const imageResponsePath = await writeJson(`data/artifacts/${auditJobId}/ace-proof-card-response.json`, trimAcePayload(result));
  const b64 = extractImageBase64(result.data);

  if (!result.ok) {
    return { imageResponsePath };
  }

  const imageUrl = extractImageUrl(result.data);
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
  const publicDir = resolve("public/proofs");
  await mkdir(publicDir, { recursive: true });

  const latestJsonPath = resolve(publicDir, "latest.json");
  const proofJsonPath = resolve(publicDir, `${packet.proofPacketId}.json`);
  const latestHtmlPath = resolve(publicDir, "latest.html");
  const proofHtmlPath = resolve(publicDir, `${packet.proofPacketId}.html`);
  const ledgerJsonPath = resolve(publicDir, "ledger.json");
  const ledgerHtmlPath = resolve(publicDir, "index.html");
  const latestCardPath = resolve(publicDir, "latest-card.png");
  const proofCardPath = resolve(publicDir, `${packet.proofPacketId}-card.png`);
  const cardSourcePath = packet.artifacts.proofCardPath ? resolve(packet.artifacts.proofCardPath) : null;

  await writeFile(latestJsonPath, `${JSON.stringify(packet, null, 2)}\n`, "utf8");
  await writeFile(proofJsonPath, `${JSON.stringify(packet, null, 2)}\n`, "utf8");

  let publicCardUrl: string | null = null;
  if (packet.artifacts.proofCardPath?.startsWith("https://")) {
    publicCardUrl = packet.artifacts.proofCardPath;
  } else if (cardSourcePath?.endsWith(".png")) {
    try {
      await copyFile(cardSourcePath, latestCardPath);
      await copyFile(cardSourcePath, proofCardPath);
      publicCardUrl = `/proofs/${packet.proofPacketId}-card.png`;
    } catch {
      publicCardUrl = null;
    }
  }

  const html = buildProofPageHtml(packet, publicCardUrl);
  await writeFile(latestHtmlPath, html, "utf8");
  await writeFile(proofHtmlPath, html, "utf8");
  const ledger = await updateProofLedger(ledgerJsonPath, packet, publicCardUrl);
  await writeFile(ledgerHtmlPath, buildLedgerPageHtml(ledger), "utf8");

  return {
    ledger: "/proofs/",
    ledgerJson: "/proofs/ledger.json",
    latestJson: "/proofs/latest.json",
    proofJson: `/proofs/${packet.proofPacketId}.json`,
    latestHtml: "/proofs/latest.html",
    proofHtml: `/proofs/${packet.proofPacketId}.html`,
    latestCard: publicCardUrl ? "/proofs/latest-card.png" : null,
    proofCard: publicCardUrl,
  };
}

interface ProofLedgerEntry {
  proofPacketId: string;
  targetName: string;
  targetAgentId: string;
  verdict: string;
  overallScore: number;
  riskFlags: string[];
  aceServicesUsed: string[];
  paymentStatus: string;
  paymentMethod: string;
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
  const payment = packet.payments[0];
  const entry: ProofLedgerEntry = {
    proofPacketId: packet.proofPacketId,
    targetName: packet.targetAgent.name,
    targetAgentId: packet.targetAgent.agentId,
    verdict: packet.scores.verdict,
    overallScore: packet.scores.overall,
    riskFlags: packet.riskFlags,
    aceServicesUsed: packet.aceAnalysis.servicesUsed,
    paymentStatus: payment?.status ?? "unknown",
    paymentMethod: payment?.method ?? "unknown",
    createdAt: packet.createdAt,
    packetHash: packet.signature?.packetHash ?? null,
    proofHtml: `/proofs/${packet.proofPacketId}.html`,
    proofJson: `/proofs/${packet.proofPacketId}.json`,
    proofCard: cardUrl,
  };
  const ledger = [entry, ...current.filter((item) => item.proofPacketId !== packet.proofPacketId)].slice(0, 100);
  await writeFile(ledgerPath, `${JSON.stringify(ledger, null, 2)}\n`, "utf8");
  return ledger;
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

function buildLedgerPageHtml(entries: ProofLedgerEntry[]): string {
  const rows = entries
    .map(
      (entry) => `<tr>
        <td><a href="${escapeHtml(entry.proofHtml)}">${escapeHtml(entry.proofPacketId)}</a></td>
        <td>${escapeHtml(entry.targetName)}</td>
        <td>${escapeHtml(entry.verdict)}</td>
        <td>${entry.overallScore}</td>
        <td>${escapeHtml(entry.paymentStatus)} / ${escapeHtml(entry.paymentMethod)}</td>
        <td>${escapeHtml(entry.aceServicesUsed.length.toString())}</td>
        <td>${escapeHtml(entry.createdAt)}</td>
      </tr>`,
    )
    .join("\n");

  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>Proofline Evidence Ledger</title>
    <style>
      :root { color-scheme: dark; --bg: #090a0b; --panel: #111417; --line: #c7a64a; --text: #f5f1e7; --muted: #a8a08e; --ok: #55f08a; }
      * { box-sizing: border-box; }
      body { margin: 0; background: var(--bg); color: var(--text); font-family: Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; }
      main { width: min(1180px, calc(100vw - 32px)); margin: 32px auto; }
      header { border-bottom: 1px solid rgba(199,166,74,.35); padding-bottom: 18px; margin-bottom: 22px; }
      h1 { margin: 0 0 8px; font-size: 28px; }
      p { color: var(--muted); }
      a { color: var(--ok); }
      table { width: 100%; border-collapse: collapse; background: var(--panel); border: 1px solid rgba(199,166,74,.35); border-radius: 8px; overflow: hidden; }
      th, td { text-align: left; padding: 12px 14px; border-bottom: 1px solid rgba(199,166,74,.18); vertical-align: top; }
      th { color: var(--muted); font-weight: 600; }
      td { overflow-wrap: anywhere; }
      tr:last-child td { border-bottom: 0; }
      @media (max-width: 780px) { table, thead, tbody, tr, th, td { display: block; } thead { display: none; } tr { border-bottom: 1px solid rgba(199,166,74,.35); } }
    </style>
  </head>
  <body>
    <main>
      <header>
        <h1>Proofline Evidence Ledger</h1>
        <p>Latest signed Execution Proof Packets generated by Proofline.</p>
        <p><a href="/proofs/latest.html">Latest proof</a> · <a href="/proofs/ledger.json">ledger.json</a></p>
      </header>
      <table>
        <thead>
          <tr><th>Proof</th><th>Target</th><th>Verdict</th><th>Score</th><th>Payment</th><th>Ace Calls</th><th>Created</th></tr>
        </thead>
        <tbody>
          ${rows || `<tr><td colspan="7">No proofs published yet.</td></tr>`}
        </tbody>
      </table>
    </main>
  </body>
</html>
`;
}

function buildProofPageHtml(packet: ExecutionProofPacket, cardUrl: string | null): string {
  const payment = packet.payments[0];
  const services = packet.aceAnalysis.servicesUsed.length > 0 ? packet.aceAnalysis.servicesUsed.join(", ") : "none";
  const risks = packet.riskFlags.length > 0 ? packet.riskFlags.join(", ") : "none";
  const signature = packet.signature;

  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>Proofline Proof Packet ${escapeHtml(packet.proofPacketId)}</title>
    <style>
      :root { color-scheme: dark; --bg: #090a0b; --panel: #111417; --line: #c7a64a; --text: #f5f1e7; --muted: #a8a08e; --ok: #55f08a; --bad: #ff5b5b; }
      * { box-sizing: border-box; }
      body { margin: 0; font-family: Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; background: var(--bg); color: var(--text); }
      main { width: min(1120px, calc(100vw - 32px)); margin: 32px auto; }
      header { display: flex; justify-content: space-between; gap: 24px; align-items: flex-start; border-bottom: 1px solid rgba(199,166,74,.35); padding-bottom: 20px; }
      h1 { margin: 0 0 8px; font-size: 28px; letter-spacing: 0; }
      p { color: var(--muted); line-height: 1.55; }
      a { color: var(--ok); }
      .grid { display: grid; grid-template-columns: minmax(0, 1.1fr) minmax(320px, .9fr); gap: 20px; margin-top: 24px; }
      .panel { border: 1px solid rgba(199,166,74,.35); background: var(--panel); border-radius: 8px; padding: 18px; }
      .card { width: 100%; border-radius: 8px; border: 1px solid rgba(199,166,74,.45); display: block; }
      dl { display: grid; grid-template-columns: 160px 1fr; gap: 10px 16px; margin: 0; }
      dt { color: var(--muted); }
      dd { margin: 0; overflow-wrap: anywhere; }
      .score { display: grid; grid-template-columns: repeat(5, 1fr); gap: 12px; margin-top: 20px; }
      .score div { border: 1px solid rgba(199,166,74,.25); border-radius: 8px; padding: 12px; }
      .score strong { display: block; font-size: 24px; margin-top: 4px; }
      .ok { color: var(--ok); }
      .bad { color: var(--bad); }
      pre { white-space: pre-wrap; overflow-wrap: anywhere; background: #070808; border: 1px solid rgba(199,166,74,.2); border-radius: 8px; padding: 14px; }
      @media (max-width: 880px) { .grid, .score { grid-template-columns: 1fr; } header { display: block; } dl { grid-template-columns: 1fr; } }
    </style>
  </head>
  <body>
    <main>
      <header>
        <div>
          <h1>Proofline Audit Proof</h1>
          <p>Signed Execution Proof Packet for ${escapeHtml(packet.targetAgent.name)}.</p>
        </div>
        <p><a href="/proofs/latest.json">latest.json</a> · <a href="/proofs/${escapeHtml(packet.proofPacketId)}.json">packet JSON</a></p>
      </header>
      <section class="grid">
        <div class="panel">
          <dl>
            <dt>Proof ID</dt><dd>${escapeHtml(packet.proofPacketId)}</dd>
            <dt>Target</dt><dd>${escapeHtml(packet.targetAgent.name)}</dd>
            <dt>Target PDA</dt><dd>${escapeHtml(packet.targetAgent.agentId)}</dd>
            <dt>Tool</dt><dd>${escapeHtml(packet.targetAgent.toolName)}</dd>
            <dt>Payment</dt><dd>${escapeHtml(payment ? `${payment.status} ${payment.amount} ${payment.currency} via ${payment.method}` : "none")}</dd>
            <dt>Sentinel</dt><dd>${escapeHtml(packet.sentinelCheck.status)}${packet.sentinelCheck.message ? `: ${escapeHtml(packet.sentinelCheck.message)}` : ""}</dd>
            <dt>Probe</dt><dd>${escapeHtml(packet.probeResult.status)}${packet.probeResult.latencyMs ? ` in ${packet.probeResult.latencyMs}ms` : ""}</dd>
            <dt>Ace Services</dt><dd>${escapeHtml(services)}</dd>
            <dt>Risk Flags</dt><dd>${escapeHtml(risks)}</dd>
            <dt>Packet Hash</dt><dd>${escapeHtml(signature?.packetHash ?? "unsigned")}</dd>
            <dt>Signature</dt><dd>${escapeHtml(signature?.signatureBase64 ?? "unsigned")}</dd>
          </dl>
          <div class="score">
            <div><span>Reliability</span><strong>${packet.scores.reliability}</strong></div>
            <div><span>Capability</span><strong>${packet.scores.capabilityMatch}</strong></div>
            <div><span>Payment</span><strong>${packet.scores.paymentIntegrity}</strong></div>
            <div><span>Safety</span><strong>${packet.scores.safety}</strong></div>
            <div><span>Overall</span><strong>${packet.scores.overall}</strong></div>
          </div>
          <h2>Summary</h2>
          <p>${escapeHtml(packet.aceAnalysis.summary ?? "No summary.")}</p>
        </div>
        <div class="panel">
          ${cardUrl ? `<img class="card" src="${escapeHtml(cardUrl)}" alt="Proofline audit proof card" />` : `<p>No public proof card was generated.</p>`}
        </div>
      </section>
      <section class="panel" style="margin-top:20px">
        <h2>Raw Probe Preview</h2>
        <pre>${escapeHtml(JSON.stringify(packet.probeResult.response ?? packet.probeResult.error ?? {}, null, 2).slice(0, 5000))}</pre>
      </section>
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
