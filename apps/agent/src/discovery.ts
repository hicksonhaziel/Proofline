import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import type { AgentTarget, AuditJob, PaymentMethod } from "../../../packages/core/src/index.js";
import type { RuntimeStore } from "../../../packages/db/src/index.js";

export interface DiscoveryContext {
  maxCostUsdc: number;
  minReauditIntervalHours: number;
}

export interface DiscoveryProvider {
  readonly name: string;
  discover(context: DiscoveryContext): Promise<DiscoveryTarget[]>;
}

export interface SapAgentResponse {
  agents?: SapAgentRecord[];
}

interface SapAgentRecord {
  pda: string;
  identity?: {
    wallet?: string;
    name?: string;
    description?: string;
    agentId?: string | null;
    agentUri?: string | null;
    x402Endpoint?: string | null;
    isActive?: boolean;
    capabilities?: Array<{ id?: string; description?: string; protocolId?: string }>;
    pricing?: PricingTier[];
    protocols?: string[];
  };
}

interface PricingTier {
  tierId?: string;
  pricePerCall?: string;
  tokenDecimals?: number | null;
  tokenMint?: string | null;
  tokenType?: Record<string, unknown>;
  settlementMode?: Record<string, unknown> | null;
}

interface AuditHistory {
  lastAuditedAt: string | null;
  failureCount: number;
}

export interface DiscoveryTarget {
  agentId: string;
  toolId: string;
  name: string;
  toolName: string;
  description: string;
  category: string;
  paymentMethod: PaymentMethod;
  source: AgentTarget["source"];
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
  status:
    | "good_audit_target"
    | "free"
    | "too_expensive"
    | "missing_endpoint"
    | "missing_pricing"
    | "unsupported_settlement"
    | "inactive"
    | "recently_audited"
    | "repeated_failures";
  reasons: string[];
  discoveredAt: string;
  hasAiSignals: boolean;
  lastAuditedAt: string | null;
  failureCount: number;
  priorityScore: number;
}

export interface DiscoverySnapshot {
  generatedAt: string;
  providerCounts: Record<string, number>;
  totalCandidates: number;
  uniqueTargets: number;
  counts: Record<string, number>;
  recommendedTargets: DiscoveryTarget[];
  allTargets: DiscoveryTarget[];
  queue: {
    path: string;
    totalJobs: number;
  };
}

export class SapDiscoveryProvider implements DiscoveryProvider {
  readonly name = "sap_explorer";

  constructor(private readonly explorerUrl: string = "https://explorer.oobeprotocol.ai/api/sap/agents") {}

  async discover(context: DiscoveryContext): Promise<DiscoveryTarget[]> {
    const response = await fetch(this.explorerUrl, {
      signal: AbortSignal.timeout(20000),
    });

    if (!response.ok) {
      throw new Error(`Synapse Explorer API returned ${response.status}: ${await response.text()}`);
    }

    const data = (await response.json()) as SapAgentResponse;
    const agents = data.agents ?? [];

    return agents.flatMap((agent) => normalizeSapAgent(agent, context.maxCostUsdc));
  }
}

export class SeedDiscoveryProvider implements DiscoveryProvider {
  readonly name = "seed_targets";

  constructor(private readonly candidatePaths: string[]) {}

  async discover(context: DiscoveryContext): Promise<DiscoveryTarget[]> {
    const targets: DiscoveryTarget[] = [];

    for (const filePath of this.candidatePaths) {
      const resolved = resolve(filePath);
      if (!existsSync(resolved)) {
        continue;
      }

      const raw = await readFile(resolved, "utf8");
      const parsed = JSON.parse(raw) as unknown;
      if (!Array.isArray(parsed)) {
        continue;
      }

      for (const item of parsed) {
        const normalized = normalizeSeedTarget(item, context.maxCostUsdc, resolved);
        if (normalized) {
          targets.push(normalized);
        }
      }
    }

    return targets;
  }
}

export async function runDiscovery(options: {
  context: DiscoveryContext;
  providers: DiscoveryProvider[];
  store?: RuntimeStore;
  maxQueueSize?: number;
  outputPaths?: {
    discoveredPath?: string;
    planPath?: string;
    queuePath?: string;
  };
}): Promise<DiscoverySnapshot> {
  const outputPaths = {
    discoveredPath: options.outputPaths?.discoveredPath ?? "data/sap/discovered-agents.json",
    planPath: options.outputPaths?.planPath ?? "data/sap/audit-target-plan.json",
    queuePath: options.outputPaths?.queuePath ?? "data/sap/audit-job-queue.json",
  };

  const providerCounts: Record<string, number> = {};
  const providerErrors: Array<{ provider: string; error: string }> = [];
  const allCandidates: DiscoveryTarget[] = [];

  for (const provider of options.providers) {
    try {
      const targets = await provider.discover(options.context);
      providerCounts[provider.name] = targets.length;
      allCandidates.push(...targets);
    } catch (error) {
      providerCounts[provider.name] = 0;
      providerErrors.push({
        provider: provider.name,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  const dedupedTargets = dedupeByAgentAndTool(allCandidates);
  const historyByTarget = options.store ? await loadAuditHistoryFromStore(options.store) : await loadAuditHistory("data/proof-packets");
  const scoredTargets = dedupedTargets.map((target) => applyHistoryAndScore(target, historyByTarget, options.context));

  const prioritizedTargets = [...scoredTargets].sort(compareTargets);
  const recommendedTargets = prioritizedTargets.filter((target) => target.status === "good_audit_target" || target.status === "free");

  const jobs = buildAuditJobs(recommendedTargets, options.context.maxCostUsdc, options.maxQueueSize ?? 25);
  const queuePayload = {
    generatedAt: new Date().toISOString(),
    totalJobs: jobs.length,
    jobs,
  };

  const discoveredPayload = {
    generatedAt: new Date().toISOString(),
    providerCounts,
    providerErrors,
    totalCandidates: allCandidates.length,
    uniqueTargets: dedupedTargets.length,
    targets: dedupedTargets,
  };

  const planPayload = {
    generatedAt: new Date().toISOString(),
    maxCostUsdc: options.context.maxCostUsdc,
    providerCounts,
    providerErrors,
    counts: countStatuses(prioritizedTargets),
    recommendedTargets: recommendedTargets.slice(0, 50),
    allTargets: prioritizedTargets,
    queuePath: outputPaths.queuePath,
  };

  if (options.store) {
    await options.store.saveDiscovery({
      generatedAt: planPayload.generatedAt,
      providerCounts,
      providerErrors,
      totalCandidates: allCandidates.length,
      uniqueTargets: dedupedTargets.length,
      counts: planPayload.counts,
      targets: prioritizedTargets,
      jobs,
      payload: planPayload,
    });
  } else {
    await writeJson(outputPaths.discoveredPath, discoveredPayload);
    await writeJson(outputPaths.planPath, planPayload);
    await writeJson(outputPaths.queuePath, queuePayload);
  }

  return {
    generatedAt: planPayload.generatedAt,
    providerCounts,
    totalCandidates: allCandidates.length,
    uniqueTargets: dedupedTargets.length,
    counts: countStatuses(prioritizedTargets),
    recommendedTargets: recommendedTargets.slice(0, 50),
    allTargets: prioritizedTargets,
    queue: {
      path: resolve(outputPaths.queuePath),
      totalJobs: jobs.length,
    },
  };
}

async function loadAuditHistoryFromStore(store: RuntimeStore): Promise<Map<string, AuditHistory>> {
  const output = new Map<string, AuditHistory>();
  const packets = await store.readProofPackets();
  for (const packet of packets) {
    const key = `${packet.targetAgent.agentId}::${packet.targetAgent.toolId}`;
    const existing = output.get(key) ?? { lastAuditedAt: null, failureCount: 0 };
    const shouldCountFailure = packet.scores.verdict === "failed" || packet.scores.verdict === "re_audit_needed";
    output.set(key, {
      lastAuditedAt: latestIso(existing.lastAuditedAt, packet.createdAt),
      failureCount: shouldCountFailure ? existing.failureCount + 1 : existing.failureCount,
    });
  }
  return output;
}

function normalizeSapAgent(agent: SapAgentRecord, maxCostUsdc: number): DiscoveryTarget[] {
  const identity = agent.identity ?? {};
  const pricing = identity.pricing ?? [];
  const base = {
    agentId: agent.pda,
    name: identity.name ?? "Unnamed SAP Agent",
    description: identity.description ?? "",
    source: "sap_discovery" as const,
    pda: agent.pda,
    wallet: identity.wallet ?? null,
    endpoint: identity.x402Endpoint ?? identity.agentUri ?? null,
    agentUri: identity.agentUri ?? null,
    protocolIds: identity.protocols ?? [],
    capabilitiesCount: identity.capabilities?.length ?? 0,
    hasAiSignals: hasAiCapability(identity.capabilities ?? [], identity.protocols ?? [], identity.description ?? ""),
    discoveredAt: new Date().toISOString(),
  };

  if (!identity.isActive) {
    return [
      {
        ...base,
        toolId: "default",
        toolName: "default",
        category: "sap_agent",
        paymentMethod: "unknown",
        pricingTier: null,
        route: "unknown",
        token: "unknown",
        pricePerCall: null,
        pricePerCallDisplay: null,
        status: "inactive",
        reasons: ["agent is inactive"],
        lastAuditedAt: null,
        failureCount: 0,
        priorityScore: 0,
      },
    ];
  }

  if (!identity.x402Endpoint && !identity.agentUri) {
    return [
      {
        ...base,
        toolId: "default",
        toolName: "default",
        category: "sap_agent",
        paymentMethod: "unknown",
        pricingTier: null,
        route: "unknown",
        token: "unknown",
        pricePerCall: null,
        pricePerCallDisplay: null,
        status: "missing_endpoint",
        reasons: ["no x402Endpoint or agentUri"],
        lastAuditedAt: null,
        failureCount: 0,
        priorityScore: 0,
      },
    ];
  }

  if (pricing.length === 0) {
    return [
      {
        ...base,
        toolId: "default",
        toolName: "default",
        category: "sap_agent",
        paymentMethod: "unknown",
        pricingTier: null,
        route: "unknown",
        token: "unknown",
        pricePerCall: null,
        pricePerCallDisplay: null,
        status: "missing_pricing",
        reasons: ["no pricing tiers listed"],
        lastAuditedAt: null,
        failureCount: 0,
        priorityScore: 0,
      },
    ];
  }

  return pricing.map((tier) => classifySapTier(base, tier, maxCostUsdc));
}

function classifySapTier(
  base: Omit<DiscoveryTarget, "toolId" | "toolName" | "category" | "paymentMethod" | "pricingTier" | "route" | "token" | "pricePerCall" | "pricePerCallDisplay" | "status" | "reasons" | "lastAuditedAt" | "failureCount" | "priorityScore">,
  tier: PricingTier,
  maxCostUsdc: number,
): DiscoveryTarget {
  const token = tokenLabel(tier);
  const route = settlementRoute(tier);
  const pricePerCallDisplay = priceDisplay(tier, token);
  const priceUsdc = estimatedUsdc(tier, token);
  const priceSol = estimatedSol(tier, token);
  const reasons: string[] = [];

  if (!isPublicEndpoint(base.endpoint)) {
    reasons.push("endpoint is missing, localhost, or non-public");
    return buildTarget(base, tier, token, route, "missing_endpoint", reasons, pricePerCallDisplay);
  }

  if (route === "unknown" || route === "instant" || route === "batched") {
    reasons.push(`settlement mode ${route} is not Phase 3 supported`);
    return buildTarget(base, tier, token, route, "unsupported_settlement", reasons, pricePerCallDisplay);
  }

  if (route === "x402" && (!base.endpoint?.startsWith("https://") || hasEndpointTemplatePlaceholder(base.endpoint))) {
    reasons.push("x402 tier but endpoint is not usable");
    return buildTarget(base, tier, token, route, "missing_endpoint", reasons, pricePerCallDisplay);
  }

  if (route === "x402" && isLikelyX402MetadataEndpoint(base.endpoint)) {
    reasons.push("x402 endpoint appears to be metadata/pricing rather than a payable resource");
    return buildTarget(base, tier, token, route, "missing_endpoint", reasons, pricePerCallDisplay);
  }

  if (priceUsdc === 0 || priceSol === 0) {
    reasons.push("free tier; useful for behavior checks but weaker for payment proof");
    return buildTarget(base, tier, token, route, "free", reasons, pricePerCallDisplay);
  }

  if (priceUsdc !== null && priceUsdc > maxCostUsdc) {
    reasons.push(`estimated cost ${priceUsdc} USDC exceeds max ${maxCostUsdc}`);
    return buildTarget(base, tier, token, route, "too_expensive", reasons, pricePerCallDisplay);
  }

  if (priceSol !== null && priceSol > 0.00035) {
    reasons.push(`SOL price ${priceSol} exceeds Phase 3 cap 0.00035 SOL`);
    return buildTarget(base, tier, token, route, "too_expensive", reasons, pricePerCallDisplay);
  }

  reasons.push("active, priced, endpoint present, and within budget");
  return buildTarget(base, tier, token, route, "good_audit_target", reasons, pricePerCallDisplay);
}

function normalizeSeedTarget(raw: unknown, maxCostUsdc: number, fromFile: string): DiscoveryTarget | null {
  if (!isRecord(raw)) {
    return null;
  }

  const agentId = stringField(raw, "agentId");
  if (!agentId) {
    return null;
  }
  const name = stringField(raw, "name") ?? "Seed Agent";
  const toolId = stringField(raw, "toolId") ?? "default";
  const toolName = stringField(raw, "toolName") ?? toolId;
  const description = stringField(raw, "description") ?? `seed target from ${fromFile}`;
  const endpoint = stringField(raw, "endpoint");
  const category = stringField(raw, "category") ?? "seed_agent";
  const source = stringField(raw, "source") === "sap_discovery" ? "sap_discovery" : "manual_seed";
  const paymentMethod = parsePaymentMethod(stringField(raw, "paymentMethod"));
  const currency = stringField(raw, "currency") ?? "unknown";
  const price = stringField(raw, "price") ?? "unknown";
  const numericPrice = Number(price);

  let status: DiscoveryTarget["status"] = "good_audit_target";
  const reasons: string[] = ["loaded from seed discovery source"];

  if (!isPublicEndpoint(endpoint ?? null)) {
    status = "missing_endpoint";
    reasons.push("seed target endpoint is missing or non-public");
  } else if (!Number.isFinite(numericPrice)) {
    status = "missing_pricing";
    reasons.push("seed target price is not numeric");
  } else if (numericPrice === 0) {
    status = "free";
    reasons.push("seed target is free");
  } else if (currency.toUpperCase() === "USDC" && numericPrice > maxCostUsdc) {
    status = "too_expensive";
    reasons.push(`seed target price ${numericPrice} USDC exceeds max ${maxCostUsdc}`);
  }

  const protocolIds = splitProtocols(raw);
  const hasAiSignals = hasAiCapability([], protocolIds, description);

  return {
    agentId,
    toolId,
    name,
    toolName,
    description,
    category,
    paymentMethod,
    source,
    pda: agentId,
    wallet: null,
    endpoint: endpoint ?? null,
    agentUri: null,
    protocolIds,
    capabilitiesCount: 0,
    pricingTier: toolId,
    route: paymentMethod === "x402" ? "x402" : paymentMethod === "sap_escrow" ? "sap_escrow" : "unknown",
    token: currency,
    pricePerCall: Number.isFinite(numericPrice) ? String(numericPrice) : null,
    pricePerCallDisplay: price === "unknown" ? null : `${price} ${currency}`,
    status,
    reasons,
    discoveredAt: new Date().toISOString(),
    hasAiSignals,
    lastAuditedAt: null,
    failureCount: 0,
    priorityScore: 0,
  };
}

function buildTarget(
  base: Omit<DiscoveryTarget, "toolId" | "toolName" | "category" | "paymentMethod" | "pricingTier" | "route" | "token" | "pricePerCall" | "pricePerCallDisplay" | "status" | "reasons" | "lastAuditedAt" | "failureCount" | "priorityScore">,
  tier: PricingTier,
  token: string,
  route: DiscoveryTarget["route"],
  status: DiscoveryTarget["status"],
  reasons: string[],
  pricePerCallDisplay: string | null,
): DiscoveryTarget {
  const toolId = tier.tierId ?? "default";
  return {
    ...base,
    toolId,
    toolName: toolId,
    category: "sap_agent",
    paymentMethod: route === "x402" ? "x402" : route === "sap_escrow" ? "sap_escrow" : "unknown",
    pricingTier: tier.tierId ?? null,
    route,
    token,
    pricePerCall: tier.pricePerCall ?? null,
    pricePerCallDisplay,
    status,
    reasons,
    lastAuditedAt: null,
    failureCount: 0,
    priorityScore: 0,
  };
}

function dedupeByAgentAndTool(targets: DiscoveryTarget[]): DiscoveryTarget[] {
  const byKey = new Map<string, DiscoveryTarget>();

  for (const target of targets) {
    const key = `${target.agentId}::${target.toolId}`;
    const existing = byKey.get(key);

    if (!existing) {
      byKey.set(key, target);
      continue;
    }

    byKey.set(key, betterDuplicate(existing, target));
  }

  return [...byKey.values()];
}

function betterDuplicate(a: DiscoveryTarget, b: DiscoveryTarget): DiscoveryTarget {
  const statusDelta = statusRank(b.status) - statusRank(a.status);
  if (statusDelta !== 0) {
    return statusDelta > 0 ? b : a;
  }

  const sourceDelta = sourceRank(b.source) - sourceRank(a.source);
  if (sourceDelta !== 0) {
    return sourceDelta > 0 ? b : a;
  }

  return b;
}

function statusRank(status: DiscoveryTarget["status"]): number {
  if (status === "good_audit_target") return 9;
  if (status === "free") return 8;
  if (status === "recently_audited") return 7;
  if (status === "repeated_failures") return 6;
  if (status === "missing_pricing") return 3;
  if (status === "missing_endpoint") return 2;
  if (status === "too_expensive") return 2;
  if (status === "unsupported_settlement") return 1;
  return 0;
}

function sourceRank(source: AgentTarget["source"]): number {
  return source === "sap_discovery" ? 2 : 1;
}

function applyHistoryAndScore(
  target: DiscoveryTarget,
  historyByTarget: Map<string, AuditHistory>,
  context: DiscoveryContext,
): DiscoveryTarget {
  const history = historyByTarget.get(`${target.agentId}::${target.toolId}`) ?? { lastAuditedAt: null, failureCount: 0 };
  const recentlyAudited = isRecentlyAudited(history.lastAuditedAt, context.minReauditIntervalHours);

  let status = target.status;
  const reasons = [...target.reasons];

  if ((status === "good_audit_target" || status === "free") && recentlyAudited) {
    status = "recently_audited";
    reasons.push(`audited within last ${context.minReauditIntervalHours}h`);
  }

  if ((status === "good_audit_target" || status === "free" || status === "recently_audited") && history.failureCount >= 2) {
    status = "repeated_failures";
    reasons.push(`previous failed/re-audit verdict count is ${history.failureCount}`);
  }

  const score = scorePriority(target, status, history, recentlyAudited);

  return {
    ...target,
    status,
    reasons,
    lastAuditedAt: history.lastAuditedAt,
    failureCount: history.failureCount,
    priorityScore: score,
  };
}

function scorePriority(
  target: DiscoveryTarget,
  status: DiscoveryTarget["status"],
  history: AuditHistory,
  recentlyAudited: boolean,
): number {
  let score = 0;

  if (status === "good_audit_target") score += 60;
  if (status === "free") score += 50;
  if (status === "recently_audited") score += 20;
  if (status === "repeated_failures") score -= 20;

  if (!history.lastAuditedAt) score += 20;
  if (target.endpoint && !target.endpoint.includes(":name") && !target.endpoint.includes("/:") && isPublicEndpoint(target.endpoint)) score += 15;
  if (target.hasAiSignals || target.capabilitiesCount > 0) score += 10;
  if (target.pricePerCall !== null || target.pricePerCallDisplay !== null) score += 10;
  if (!recentlyAudited) score += 10;
  if (target.route === "x402" || target.route === "sap_escrow") score += 10;
  if (target.token === "USDC" || target.token === "SOL" || target.token.startsWith("SPL:")) score += 5;
  if (history.failureCount > 0) score -= history.failureCount * 8;

  return score;
}

function compareTargets(a: DiscoveryTarget, b: DiscoveryTarget): number {
  if (b.priorityScore !== a.priorityScore) {
    return b.priorityScore - a.priorityScore;
  }

  if (statusRank(b.status) !== statusRank(a.status)) {
    return statusRank(b.status) - statusRank(a.status);
  }

  return a.name.localeCompare(b.name);
}

async function loadAuditHistory(proofPacketsDir: string): Promise<Map<string, AuditHistory>> {
  const output = new Map<string, AuditHistory>();
  const directory = resolve(proofPacketsDir);

  if (!existsSync(directory)) {
    return output;
  }

  const files = await readdir(directory);
  for (const file of files) {
    if (!file.endsWith(".json")) {
      continue;
    }

    const path = resolve(directory, file);

    try {
      const raw = await readFile(path, "utf8");
      const packet = JSON.parse(raw) as unknown;
      if (!isRecord(packet)) {
        continue;
      }

      const targetAgent = isRecord(packet.targetAgent) ? packet.targetAgent : null;
      const agentId = targetAgent && typeof targetAgent.agentId === "string" ? targetAgent.agentId : null;
      const toolId = targetAgent && typeof targetAgent.toolId === "string" ? targetAgent.toolId : "default";
      if (!agentId) {
        continue;
      }

      const key = `${agentId}::${toolId}`;
      const existing = output.get(key) ?? { lastAuditedAt: null, failureCount: 0 };
      const createdAt = typeof packet.createdAt === "string" ? packet.createdAt : null;
      const verdict = readVerdict(packet);
      const shouldCountFailure = verdict === "failed" || verdict === "re_audit_needed";

      const nextLastAuditedAt = latestIso(existing.lastAuditedAt, createdAt);
      output.set(key, {
        lastAuditedAt: nextLastAuditedAt,
        failureCount: shouldCountFailure ? existing.failureCount + 1 : existing.failureCount,
      });
    } catch {
      continue;
    }
  }

  return output;
}

function readVerdict(packet: Record<string, unknown>): string | null {
  const scores = isRecord(packet.scores) ? packet.scores : null;
  return scores && typeof scores.verdict === "string" ? scores.verdict : null;
}

function latestIso(a: string | null, b: string | null): string | null {
  if (!a) return b;
  if (!b) return a;

  const aTime = Date.parse(a);
  const bTime = Date.parse(b);

  if (!Number.isFinite(aTime)) return b;
  if (!Number.isFinite(bTime)) return a;
  return bTime > aTime ? b : a;
}

function isRecentlyAudited(lastAuditedAt: string | null, minimumHours: number): boolean {
  if (!lastAuditedAt) {
    return false;
  }

  const time = Date.parse(lastAuditedAt);
  if (!Number.isFinite(time)) {
    return false;
  }

  const elapsedHours = (Date.now() - time) / (1000 * 60 * 60);
  return elapsedHours < minimumHours;
}

function buildAuditJobs(targets: DiscoveryTarget[], maxSpendUsdc: number, maxJobs: number): AuditJob[] {
  const queued: AuditJob[] = [];

  for (const target of targets) {
    if (queued.length >= maxJobs) {
      break;
    }

    if (!target.endpoint || target.endpoint.includes(":name") || target.endpoint.includes("/:")) {
      continue;
    }

    const agentTarget: AgentTarget = {
      agentId: target.agentId,
      name: target.name,
      toolId: target.toolId,
      toolName: target.toolName,
      description: target.description,
      category: target.category,
      price: target.pricePerCallDisplay ?? "unknown",
      currency: target.token,
      paymentMethod: target.paymentMethod,
      endpoint: target.endpoint,
      source: target.source,
    };

    queued.push({
      auditJobId: `job_${randomUUID()}`,
      target: agentTarget,
      status: "queued",
      createdAt: new Date().toISOString(),
      maxSpendUsdc,
    });
  }

  return queued;
}

function countStatuses(targets: DiscoveryTarget[]): Record<string, number> {
  const counts: Record<string, number> = {};

  for (const target of targets) {
    counts[target.status] = (counts[target.status] ?? 0) + 1;
  }

  return counts;
}

function tokenLabel(tier: PricingTier): string {
  const tokenType = tier.tokenType ?? {};
  if ("usdc" in tokenType) return "USDC";
  if ("sol" in tokenType) return "SOL";
  if ("spl" in tokenType) return tier.tokenMint ? `SPL:${tier.tokenMint}` : "SPL";
  return tier.tokenMint ? `SPL:${tier.tokenMint}` : "unknown";
}

function settlementRoute(tier: PricingTier): DiscoveryTarget["route"] {
  const mode = tier.settlementMode ?? {};
  if ("x402" in mode) return "x402";
  if ("escrow" in mode) return "sap_escrow";
  if ("instant" in mode) return "instant";
  if ("batched" in mode) return "batched";
  return "unknown";
}

function priceDisplay(tier: PricingTier, token: string): string | null {
  if (!tier.pricePerCall) return null;
  const decimals = decimalsFor(tier, token);
  return `${Number(tier.pricePerCall) / 10 ** decimals} ${token}`;
}

function estimatedUsdc(tier: PricingTier, token: string): number | null {
  if (!tier.pricePerCall) return null;
  const decimals = decimalsFor(tier, token);
  const nativeAmount = Number(tier.pricePerCall) / 10 ** decimals;
  if (token === "USDC" || token.startsWith("SPL:EPjFWdd5")) return nativeAmount;
  return null;
}

function estimatedSol(tier: PricingTier, token: string): number | null {
  if (!tier.pricePerCall || token !== "SOL") return null;
  const decimals = decimalsFor(tier, token);
  return Number(tier.pricePerCall) / 10 ** decimals;
}

function decimalsFor(tier: PricingTier, token: string): number {
  if (typeof tier.tokenDecimals === "number") return tier.tokenDecimals;
  if (token === "USDC" || token.startsWith("SPL:")) return 6;
  if (token === "SOL") return 9;
  return 9;
}

function isPublicEndpoint(endpoint: string | null): boolean {
  if (!endpoint) return false;

  try {
    const url = new URL(endpoint);
    return (
      url.protocol === "https:" &&
      !url.hostname.endsWith(".local") &&
      url.hostname !== "localhost" &&
      !url.hostname.includes("example.com") &&
      !url.hostname.includes("your-agent-endpoint")
    );
  } catch {
    return false;
  }
}

function isLikelyX402MetadataEndpoint(endpoint: string | null): boolean {
  if (!endpoint) return false;

  try {
    const url = new URL(endpoint);
    const normalized = `${url.pathname}${url.hash}`.toLowerCase();
    return (
      url.hostname.toLowerCase() === "github.com" ||
      normalized.includes("/.well-known/x402") ||
      normalized.endsWith("/pricing") ||
      normalized.endsWith("/manifest") ||
      normalized.includes("/manifest/") ||
      normalized.includes("/openapi")
    );
  } catch {
    return false;
  }
}

function hasEndpointTemplatePlaceholder(endpoint: string | null): boolean {
  return Boolean(endpoint?.includes("/:") || endpoint?.includes(":name"));
}

function hasAiCapability(
  capabilities: Array<{ id?: string; description?: string; protocolId?: string }>,
  protocols: string[],
  description: string,
): boolean {
  const capabilityText = capabilities
    .map((item) => `${item.id ?? ""} ${item.description ?? ""} ${item.protocolId ?? ""}`.toLowerCase())
    .join(" ");
  const protocolText = protocols.join(" ").toLowerCase();
  const merged = `${capabilityText} ${protocolText} ${description.toLowerCase()}`;
  const signals = ["ai", "llm", "chat", "ace", "search", "image", "translate", "audio", "summar"];
  return signals.some((signal) => merged.includes(signal));
}

function splitProtocols(raw: Record<string, unknown>): string[] {
  const protocols = raw.protocols;
  if (!Array.isArray(protocols)) {
    return [];
  }

  return protocols.filter((value): value is string => typeof value === "string");
}

function parsePaymentMethod(value: string | null): PaymentMethod {
  if (value === "x402" || value === "sap_escrow" || value === "manual_seed" || value === "unknown") {
    return value;
  }

  return "unknown";
}

function stringField(value: Record<string, unknown>, key: string): string | null {
  const field = value[key];
  return typeof field === "string" && field.length > 0 ? field : null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

async function writeJson(path: string, value: unknown): Promise<void> {
  const outputPath = resolve(path);
  await mkdir(dirname(outputPath), { recursive: true });
  await writeFile(outputPath, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}
