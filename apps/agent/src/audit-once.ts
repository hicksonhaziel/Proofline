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
    latestCard: publicCardUrl,
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

function prooflinePageHead(title: string): string {
  return `<head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>${escapeHtml(title)}</title>
    <script src="https://cdn.tailwindcss.com?plugins=forms,container-queries"></script>
    <link rel="preconnect" href="https://fonts.gstatic.com/" crossorigin />
    <link rel="stylesheet" href="https://fonts.googleapis.com/css2?display=swap&family=Geist%3Awght%40400%3B500%3B600%3B700%3B800" />
    <link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Material+Symbols+Outlined" />
    <script>
      tailwind.config = {
        darkMode: "class",
        theme: {
          extend: {
            colors: {
              primary: "#d6b45a",
              "primary-soft": "#f4d37b",
              surface: "#090a0b",
              "surface-panel": "#111417",
              "surface-panel-2": "#171b1f",
              "surface-line": "rgba(214,180,90,0.24)",
              "text-main": "#f6f1e7",
              "text-muted": "#a8a08e"
            },
            fontFamily: { display: ["Geist", "Inter", "sans-serif"] },
            borderRadius: { DEFAULT: "0.5rem" }
          }
        }
      };
    </script>
    <style>
      body { font-family: Geist, Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; }
      .proofline-grid { background-image: linear-gradient(rgba(214,180,90,.035) 1px, transparent 1px), linear-gradient(90deg, rgba(214,180,90,.035) 1px, transparent 1px); background-size: 36px 36px; }
      .material-symbols-outlined { font-variation-settings: "FILL" 0, "wght" 500, "GRAD" 0, "opsz" 24; }
    </style>
  </head>`;
}

function prooflineHeader(active: "ledger" | "proof"): string {
  const ledgerClass = active === "ledger" ? "text-primary" : "text-text-muted hover:text-text-main";
  const proofClass = active === "proof" ? "text-primary" : "text-text-muted hover:text-text-main";
  return `<header class="sticky top-0 z-20 border-b border-surface-line bg-surface/90 backdrop-blur">
      <div class="mx-auto flex max-w-7xl items-center justify-between px-5 py-3 sm:px-8">
        <a class="flex items-center gap-3" href="/proofs/">
          <img src="/proofline.png" alt="Proofline" class="h-10 w-10 rounded border border-surface-line object-cover" />
          <div>
            <p class="text-sm font-semibold uppercase tracking-[0.18em] text-primary">Proofline</p>
            <p class="text-xs text-text-muted">Execution proof network</p>
          </div>
        </a>
        <nav class="flex items-center gap-5 text-sm font-medium">
          <a class="${ledgerClass}" href="/proofs/">Ledger</a>
          <a class="${proofClass}" href="/proofs/latest.html">Latest Proof</a>
          <a class="hidden text-text-muted hover:text-text-main sm:inline" href="/proofs/ledger.json">JSON</a>
        </nav>
      </div>
    </header>`;
}

function verdictClass(verdict: string): string {
  const normalized = verdict.toLowerCase();
  if (normalized.includes("pass") || normalized.includes("good") || normalized.includes("low")) {
    return "border-emerald-400/30 bg-emerald-400/10 text-emerald-200";
  }
  if (normalized.includes("fail") || normalized.includes("high") || normalized.includes("critical")) {
    return "border-red-400/30 bg-red-400/10 text-red-200";
  }
  return "border-amber-300/30 bg-amber-300/10 text-amber-100";
}

function scoreTone(score: number): string {
  if (score >= 75) return "text-emerald-200";
  if (score >= 50) return "text-primary-soft";
  return "text-red-200";
}

function formatProofDate(value: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return date.toISOString().replace("T", " ").slice(0, 16);
}

function shortProofId(value: string): string {
  return value.length > 18 ? `${value.slice(0, 10)}...${value.slice(-6)}` : value;
}

function scoreBar(label: string, score: number): string {
  const bounded = Math.max(0, Math.min(100, Math.round(score)));
  return `<div class="rounded border border-surface-line bg-surface-panel-2 p-4">
      <div class="mb-3 flex items-center justify-between gap-3">
        <span class="text-sm text-text-muted">${escapeHtml(label)}</span>
        <span class="font-semibold ${scoreTone(bounded)}">${bounded}</span>
      </div>
      <div class="h-2 overflow-hidden rounded-full bg-black/40">
        <div class="h-full rounded-full bg-primary" style="width:${bounded}%"></div>
      </div>
    </div>`;
}

function buildLedgerPageHtml(entries: ProofLedgerEntry[]): string {
  const latest = entries[0];
  const totalProofs = entries.length;
  const latestScore = latest ? latest.overallScore.toString() : "0";
  const serviceCount = new Set(entries.flatMap((entry) => entry.aceServicesUsed)).size;
  const rows = entries
    .map(
      (entry) => `<tr class="border-b border-surface-line last:border-0">
        <td class="px-5 py-4 align-top">
          <a class="font-mono text-sm text-primary-soft hover:text-primary" href="${escapeHtml(entry.proofHtml)}">${escapeHtml(shortProofId(entry.proofPacketId))}</a>
          <p class="mt-1 max-w-[220px] truncate text-xs text-text-muted">${escapeHtml(entry.packetHash ?? "unsigned")}</p>
        </td>
        <td class="px-5 py-4 align-top">
          <p class="font-medium text-text-main">${escapeHtml(entry.targetName)}</p>
          <p class="mt-1 max-w-[220px] truncate text-xs text-text-muted">${escapeHtml(entry.targetAgentId)}</p>
        </td>
        <td class="px-5 py-4 align-top">
          <span class="inline-flex rounded-full border px-3 py-1 text-xs font-semibold ${verdictClass(entry.verdict)}">${escapeHtml(entry.verdict)}</span>
        </td>
        <td class="px-5 py-4 align-top">
          <span class="text-lg font-bold ${scoreTone(entry.overallScore)}">${entry.overallScore}</span>
          <span class="text-xs text-text-muted">/100</span>
        </td>
        <td class="px-5 py-4 align-top">
          <p class="text-sm text-text-main">${escapeHtml(entry.paymentStatus)}</p>
          <p class="text-xs text-text-muted">${escapeHtml(entry.paymentMethod)}</p>
        </td>
        <td class="px-5 py-4 align-top text-sm text-text-main">${escapeHtml(entry.aceServicesUsed.length.toString())}</td>
        <td class="px-5 py-4 align-top text-sm text-text-muted">${escapeHtml(formatProofDate(entry.createdAt))}</td>
        <td class="px-5 py-4 align-top">
          <div class="flex items-center gap-2">
            <a class="rounded border border-surface-line p-2 text-text-muted hover:border-primary hover:text-primary" href="${escapeHtml(entry.proofHtml)}" title="View proof"><span class="material-symbols-outlined text-[18px]">visibility</span></a>
            <a class="rounded border border-surface-line p-2 text-text-muted hover:border-primary hover:text-primary" href="${escapeHtml(entry.proofJson)}" title="View JSON"><span class="material-symbols-outlined text-[18px]">data_object</span></a>
            ${entry.proofCard ? `<a class="rounded border border-surface-line p-2 text-text-muted hover:border-primary hover:text-primary" href="${escapeHtml(entry.proofCard)}" title="View proof card"><span class="material-symbols-outlined text-[18px]">image</span></a>` : ""}
          </div>
        </td>
      </tr>`,
    )
    .join("\n");

  return `<!doctype html>
<html lang="en" class="dark">
  ${prooflinePageHead("Proofline Evidence Ledger")}
  <body class="proofline-grid min-h-screen bg-surface text-text-main">
    ${prooflineHeader("ledger")}
    <main class="mx-auto max-w-7xl px-5 py-8 sm:px-8">
      <section class="mb-8 flex flex-col gap-6 lg:flex-row lg:items-end lg:justify-between">
        <div>
          <p class="text-sm font-semibold uppercase tracking-[0.2em] text-primary">Evidence ledger</p>
          <h1 class="mt-3 text-3xl font-bold tracking-normal text-text-main sm:text-5xl">Signed execution proofs</h1>
          <p class="mt-4 max-w-3xl text-sm leading-6 text-text-muted sm:text-base">Proofline records agent audits as public proof packets: payment route, probe result, Sentinel status, Ace analysis, proof card, hash, and wallet signature.</p>
        </div>
        <div class="flex flex-wrap gap-3">
          <a class="inline-flex items-center gap-2 rounded border border-primary/40 bg-primary/10 px-4 py-2 text-sm font-semibold text-primary-soft hover:bg-primary/15" href="/proofs/latest.html"><span class="material-symbols-outlined text-[18px]">receipt_long</span>Latest proof</a>
          <a class="inline-flex items-center gap-2 rounded border border-surface-line bg-surface-panel px-4 py-2 text-sm font-semibold text-text-muted hover:text-text-main" href="/proofs/ledger.json"><span class="material-symbols-outlined text-[18px]">data_object</span>ledger.json</a>
        </div>
      </section>

      <section class="mb-8 grid gap-4 md:grid-cols-3">
        <div class="rounded border border-surface-line bg-surface-panel p-5">
          <p class="text-sm text-text-muted">Total proofs</p>
          <p class="mt-2 text-3xl font-bold">${totalProofs}</p>
        </div>
        <div class="rounded border border-surface-line bg-surface-panel p-5">
          <p class="text-sm text-text-muted">Latest overall score</p>
          <p class="mt-2 text-3xl font-bold ${scoreTone(Number(latestScore))}">${escapeHtml(latestScore)}<span class="text-base text-text-muted">/100</span></p>
        </div>
        <div class="rounded border border-surface-line bg-surface-panel p-5">
          <p class="text-sm text-text-muted">Ace services seen</p>
          <p class="mt-2 text-3xl font-bold">${serviceCount}</p>
        </div>
      </section>

      <section class="overflow-hidden rounded border border-surface-line bg-surface-panel shadow-2xl shadow-black/20">
        <div class="flex flex-col gap-4 border-b border-surface-line p-5 md:flex-row md:items-center md:justify-between">
          <div>
            <h2 class="text-xl font-semibold">Proof events</h2>
            <p class="mt-1 text-sm text-text-muted">Newest packet first. Each row links to the human proof, raw JSON, and card artifact.</p>
          </div>
          <div class="flex flex-wrap gap-2 text-xs font-semibold">
            <span class="rounded-full border border-surface-line px-3 py-1 text-text-muted">SAP</span>
            <span class="rounded-full border border-surface-line px-3 py-1 text-text-muted">x402</span>
            <span class="rounded-full border border-surface-line px-3 py-1 text-text-muted">Ace Data Cloud</span>
            <span class="rounded-full border border-surface-line px-3 py-1 text-text-muted">Signed</span>
          </div>
        </div>
        <div class="overflow-x-auto">
          <table class="min-w-full text-left">
            <thead class="border-b border-surface-line bg-black/20 text-xs uppercase tracking-[0.14em] text-text-muted">
              <tr><th class="px-5 py-3">Proof</th><th class="px-5 py-3">Target</th><th class="px-5 py-3">Verdict</th><th class="px-5 py-3">Score</th><th class="px-5 py-3">Payment</th><th class="px-5 py-3">Ace</th><th class="px-5 py-3">Created</th><th class="px-5 py-3">Open</th></tr>
            </thead>
            <tbody>
              ${rows || `<tr><td class="px-5 py-8 text-text-muted" colspan="8">No proofs published yet.</td></tr>`}
            </tbody>
          </table>
        </div>
      </section>
    </main>
  </body>
</html>
`;
}

function buildProofPageHtml(packet: ExecutionProofPacket, cardUrl: string | null): string {
  const payment = packet.payments[0];
  const services = packet.aceAnalysis.servicesUsed.length > 0 ? packet.aceAnalysis.servicesUsed.join(", ") : "none";
  const serviceChips =
    packet.aceAnalysis.servicesUsed.length > 0
      ? packet.aceAnalysis.servicesUsed
          .map((service) => `<span class="rounded-full border border-surface-line bg-surface-panel-2 px-3 py-1 text-xs font-semibold text-text-muted">${escapeHtml(service)}</span>`)
          .join("")
      : `<span class="rounded-full border border-surface-line bg-surface-panel-2 px-3 py-1 text-xs font-semibold text-text-muted">none</span>`;
  const riskChips =
    packet.riskFlags.length > 0
      ? packet.riskFlags.map((risk) => `<span class="rounded-full border border-amber-300/30 bg-amber-300/10 px-3 py-1 text-xs font-semibold text-amber-100">${escapeHtml(risk)}</span>`).join("")
      : `<span class="rounded-full border border-emerald-400/30 bg-emerald-400/10 px-3 py-1 text-xs font-semibold text-emerald-200">no risk flags</span>`;
  const signature = packet.signature;
  const probeOk = packet.probeResult.status === "success";
  const sentinelOk = packet.sentinelCheck.status === "healthy";
  const paymentLabel = payment ? `${payment.status} ${payment.amount} ${payment.currency}` : "not paid";
  const paymentProof = payment?.transactionHash ?? payment?.receipt ?? payment?.paymentId;
  const paymentRoute = payment ? `${payment.method}${paymentProof ? ` / ${paymentProof}` : ""}` : "none";
  const responsePreview = JSON.stringify(packet.probeResult.response ?? packet.probeResult.error ?? {}, null, 2).slice(0, 5000);

  return `<!doctype html>
<html lang="en" class="dark">
  ${prooflinePageHead(`Proofline Proof Packet ${packet.proofPacketId}`)}
  <body class="proofline-grid min-h-screen bg-surface text-text-main">
    ${prooflineHeader("proof")}
    <main class="mx-auto max-w-7xl px-5 py-8 sm:px-8">
      <section class="mb-8 flex flex-col gap-6 lg:flex-row lg:items-end lg:justify-between">
        <div>
          <p class="text-sm font-semibold uppercase tracking-[0.2em] text-primary">Execution proof packet</p>
          <h1 class="mt-3 text-3xl font-bold tracking-normal text-text-main sm:text-5xl">${escapeHtml(packet.targetAgent.name)}</h1>
          <p class="mt-4 max-w-3xl text-sm leading-6 text-text-muted">${escapeHtml(packet.aceAnalysis.summary ?? "Signed Proofline audit packet with payment, probe, Sentinel, Ace analysis, and card artifacts.")}</p>
        </div>
        <div class="flex flex-wrap gap-3">
          <a class="inline-flex items-center gap-2 rounded border border-surface-line bg-surface-panel px-4 py-2 text-sm font-semibold text-text-muted hover:text-text-main" href="/proofs/"><span class="material-symbols-outlined text-[18px]">table</span>Ledger</a>
          <a class="inline-flex items-center gap-2 rounded border border-primary/40 bg-primary/10 px-4 py-2 text-sm font-semibold text-primary-soft hover:bg-primary/15" href="/proofs/${escapeHtml(packet.proofPacketId)}.json"><span class="material-symbols-outlined text-[18px]">data_object</span>Packet JSON</a>
        </div>
      </section>

      <section class="grid gap-6 lg:grid-cols-[minmax(0,1fr)_420px]">
        <div class="space-y-6">
          <section class="rounded border border-surface-line bg-surface-panel p-5 shadow-2xl shadow-black/20">
            <div class="flex flex-col gap-4 border-b border-surface-line pb-5 md:flex-row md:items-start md:justify-between">
              <div>
                <h2 class="text-xl font-semibold">Audit summary</h2>
                <p class="mt-1 font-mono text-xs text-text-muted">${escapeHtml(packet.proofPacketId)}</p>
              </div>
              <span class="inline-flex w-fit rounded-full border px-3 py-1 text-xs font-semibold ${verdictClass(packet.scores.verdict)}">${escapeHtml(packet.scores.verdict)}</span>
            </div>
            <div class="mt-5 grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
              <div class="rounded border border-surface-line bg-surface-panel-2 p-4"><p class="text-xs text-text-muted">Overall score</p><p class="mt-2 text-3xl font-bold ${scoreTone(packet.scores.overall)}">${packet.scores.overall}<span class="text-sm text-text-muted">/100</span></p></div>
              <div class="rounded border border-surface-line bg-surface-panel-2 p-4"><p class="text-xs text-text-muted">Target tool</p><p class="mt-2 truncate text-sm font-semibold">${escapeHtml(packet.targetAgent.toolName)}</p></div>
              <div class="rounded border border-surface-line bg-surface-panel-2 p-4"><p class="text-xs text-text-muted">Payment</p><p class="mt-2 truncate text-sm font-semibold">${escapeHtml(paymentLabel)}</p></div>
              <div class="rounded border border-surface-line bg-surface-panel-2 p-4"><p class="text-xs text-text-muted">Created</p><p class="mt-2 text-sm font-semibold">${escapeHtml(formatProofDate(packet.createdAt))}</p></div>
            </div>
          </section>

          <section class="rounded border border-surface-line bg-surface-panel p-5">
            <h2 class="text-xl font-semibold">Metrics breakdown</h2>
            <div class="mt-5 grid gap-4 md:grid-cols-2">
              ${scoreBar("Reliability", packet.scores.reliability)}
              ${scoreBar("Capability match", packet.scores.capabilityMatch)}
              ${scoreBar("Payment integrity", packet.scores.paymentIntegrity)}
              ${scoreBar("Safety", packet.scores.safety)}
            </div>
          </section>

          <section class="rounded border border-surface-line bg-surface-panel p-5">
            <h2 class="text-xl font-semibold">Verification timeline</h2>
            <div class="mt-5 space-y-4">
              <div class="flex gap-4"><span class="material-symbols-outlined mt-0.5 ${payment ? "text-emerald-300" : "text-amber-200"}">${payment ? "check_circle" : "pending"}</span><div><p class="font-semibold">Payment route checked</p><p class="mt-1 break-all text-sm text-text-muted">${escapeHtml(paymentRoute)}</p></div></div>
              <div class="flex gap-4"><span class="material-symbols-outlined mt-0.5 ${sentinelOk ? "text-emerald-300" : "text-amber-200"}">${sentinelOk ? "check_circle" : "warning"}</span><div><p class="font-semibold">Sentinel status reviewed</p><p class="mt-1 text-sm text-text-muted">${escapeHtml(packet.sentinelCheck.status)}${packet.sentinelCheck.message ? ` - ${escapeHtml(packet.sentinelCheck.message)}` : ""}</p></div></div>
              <div class="flex gap-4"><span class="material-symbols-outlined mt-0.5 ${probeOk ? "text-emerald-300" : "text-red-200"}">${probeOk ? "check_circle" : "error"}</span><div><p class="font-semibold">Tool probe completed</p><p class="mt-1 text-sm text-text-muted">${escapeHtml(packet.probeResult.status)}${packet.probeResult.latencyMs ? ` in ${packet.probeResult.latencyMs}ms` : ""}</p></div></div>
              <div class="flex gap-4"><span class="material-symbols-outlined mt-0.5 text-primary">verified</span><div><p class="font-semibold">Packet hashed and signed</p><p class="mt-1 break-all font-mono text-xs text-text-muted">${escapeHtml(signature?.packetHash ?? "unsigned")}</p></div></div>
            </div>
          </section>

          <section class="grid gap-6 lg:grid-cols-2">
            <div class="rounded border border-surface-line bg-surface-panel p-5">
              <h2 class="text-xl font-semibold">Ace usage</h2>
              <p class="mt-2 text-sm text-text-muted">${escapeHtml(services)}</p>
              <div class="mt-4 flex flex-wrap gap-2">${serviceChips}</div>
            </div>
            <div class="rounded border border-surface-line bg-surface-panel p-5">
              <h2 class="text-xl font-semibold">Risk flags</h2>
              <div class="mt-4 flex flex-wrap gap-2">${riskChips}</div>
            </div>
          </section>

          <section class="rounded border border-surface-line bg-surface-panel p-5">
            <h2 class="text-xl font-semibold">Raw probe preview</h2>
            <pre class="mt-4 max-h-[420px] overflow-auto rounded border border-surface-line bg-black/40 p-4 text-xs leading-5 text-text-muted">${escapeHtml(responsePreview)}</pre>
          </section>
        </div>

        <aside class="space-y-6">
          <section class="rounded border border-surface-line bg-surface-panel p-5">
            <h2 class="text-xl font-semibold">Proof card</h2>
            <p class="mt-1 text-sm text-text-muted">Branded card artifact produced from the Proofline template.</p>
            ${cardUrl ? `<img class="mt-5 w-full rounded border border-surface-line object-cover" src="${escapeHtml(cardUrl)}" alt="Proofline audit proof card" />` : `<div class="mt-5 rounded border border-surface-line bg-black/30 p-6 text-sm text-text-muted">No public proof card was generated.</div>`}
            <div class="mt-5 grid gap-3">
              ${cardUrl ? `<a class="inline-flex items-center justify-center gap-2 rounded border border-primary/40 bg-primary/10 px-4 py-2 text-sm font-semibold text-primary-soft hover:bg-primary/15" href="${escapeHtml(cardUrl)}"><span class="material-symbols-outlined text-[18px]">image</span>Open card</a>` : ""}
              <a class="inline-flex items-center justify-center gap-2 rounded border border-surface-line bg-surface-panel-2 px-4 py-2 text-sm font-semibold text-text-muted hover:text-text-main" href="/proofs/${escapeHtml(packet.proofPacketId)}.json"><span class="material-symbols-outlined text-[18px]">data_object</span>Open JSON</a>
            </div>
          </section>

          <section class="rounded border border-surface-line bg-surface-panel p-5">
            <h2 class="text-xl font-semibold">Cryptographic integrity</h2>
            <dl class="mt-5 space-y-4 text-sm">
              <div><dt class="text-text-muted">Algorithm</dt><dd class="mt-1 font-mono">${escapeHtml(signature?.algorithm ?? "unsigned")}</dd></div>
              <div><dt class="text-text-muted">Signer</dt><dd class="mt-1 break-all font-mono text-xs">${escapeHtml(signature?.publicKey ?? "unknown")}</dd></div>
              <div><dt class="text-text-muted">Signature</dt><dd class="mt-1 break-all font-mono text-xs">${escapeHtml(signature?.signatureBase64 ?? "unsigned")}</dd></div>
              <div><dt class="text-text-muted">Signed at</dt><dd class="mt-1">${escapeHtml(signature?.signedAt ? formatProofDate(signature.signedAt) : "unknown")}</dd></div>
            </dl>
          </section>

          <section class="rounded border border-surface-line bg-surface-panel p-5">
            <h2 class="text-xl font-semibold">Target identity</h2>
            <dl class="mt-5 space-y-4 text-sm">
              <div><dt class="text-text-muted">Agent PDA</dt><dd class="mt-1 break-all font-mono text-xs">${escapeHtml(packet.targetAgent.agentId)}</dd></div>
              <div><dt class="text-text-muted">Endpoint</dt><dd class="mt-1 break-all font-mono text-xs">${escapeHtml(packet.targetAgent.endpoint ?? "unknown")}</dd></div>
              <div><dt class="text-text-muted">Payment method</dt><dd class="mt-1 break-all font-mono text-xs">${escapeHtml(packet.targetAgent.paymentMethod)}</dd></div>
            </dl>
          </section>
        </aside>
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
