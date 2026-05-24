import { mkdir, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { loadConfig } from "./config.js";
import { createLogger } from "./logger.js";

interface SapAgentResponse {
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
    capabilities?: unknown[];
    pricing?: PricingTier[];
    protocols?: string[];
  };
  computed?: {
    hasX402?: boolean;
    pricingTierCount?: number;
    capabilityCount?: number;
  };
}

interface PricingTier {
  tierId?: string;
  pricePerCall?: string;
  tokenDecimals?: number | null;
  tokenMint?: string | null;
  tokenType?: Record<string, unknown>;
  settlementMode?: Record<string, unknown> | null;
  minEscrowDeposit?: string | null;
  maxCallsPerSession?: number;
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
  status:
    | "good_audit_target"
    | "free"
    | "too_expensive"
    | "missing_endpoint"
    | "missing_pricing"
    | "unsupported_settlement"
    | "inactive";
  reasons: string[];
}

async function main(): Promise<void> {
  const runId = `sap_discover_${Date.now()}`;
  const logger = createLogger(runId);
  const config = loadConfig();
  const maxCostUsdc = config.limits.maxSpendPerAuditUsdc;

  logger.info("Starting SAP discovery", {
    explorerApi: "https://explorer.oobeprotocol.ai/api/sap/agents",
    maxCostUsdc,
  });

  const response = await fetch("https://explorer.oobeprotocol.ai/api/sap/agents");
  if (!response.ok) {
    throw new Error(`Synapse Explorer API returned ${response.status}: ${await response.text()}`);
  }

  const data = (await response.json()) as SapAgentResponse;
  const agents = data.agents ?? [];
  const plannedTargets = agents.flatMap((agent) => planAgent(agent, maxCostUsdc));
  const recommendedTargets = plannedTargets
    .filter((target) => target.status === "good_audit_target" || target.status === "free")
    .sort(compareTargets);

  const discoveredPath = await writeJson("data/sap/discovered-agents.json", {
    generatedAt: new Date().toISOString(),
    totalAgents: agents.length,
    agents,
  });
  const planPath = await writeJson("data/sap/audit-target-plan.json", {
    generatedAt: new Date().toISOString(),
    maxCostUsdc,
    counts: countStatuses(plannedTargets),
    recommendedTargets: recommendedTargets.slice(0, 20),
    allTargets: plannedTargets,
  });

  logger.info("SAP discovery complete", {
    totalAgents: agents.length,
    plannedTargets: plannedTargets.length,
    recommendedTargets: recommendedTargets.length,
    discoveredPath,
    planPath,
  });

  for (const target of recommendedTargets.slice(0, 8)) {
    logger.info("Recommended audit target", {
      name: target.name,
      price: target.pricePerCallDisplay,
      route: target.route,
      token: target.token,
      endpoint: target.endpoint,
      status: target.status,
    });
  }
}

function planAgent(agent: SapAgentRecord, maxCostUsdc: number): PlannedTarget[] {
  const identity = agent.identity ?? {};
  const pricing = identity.pricing ?? [];

  if (!identity.isActive) {
    return [baseTarget(agent, null, "inactive", ["agent is inactive"])];
  }

  if (!identity.x402Endpoint && !identity.agentUri) {
    return [baseTarget(agent, null, "missing_endpoint", ["no x402Endpoint or agentUri"])];
  }

  if (pricing.length === 0) {
    return [baseTarget(agent, null, "missing_pricing", ["no pricing tiers listed"])];
  }

  return pricing.map((tier) => classifyTier(agent, tier, maxCostUsdc));
}

function classifyTier(agent: SapAgentRecord, tier: PricingTier, maxCostUsdc: number): PlannedTarget {
  const token = tokenLabel(tier);
  const route = settlementRoute(tier);
  const display = priceDisplay(tier, token);
  const priceUsdc = estimatedUsdc(tier, token);
  const priceSol = estimatedSol(tier, token);
  const reasons: string[] = [];

  if (!isPublicEndpoint(agent.identity?.x402Endpoint ?? agent.identity?.agentUri ?? null)) {
    reasons.push("endpoint is missing, localhost, or non-public");
    return baseTarget(agent, tier, "missing_endpoint", reasons);
  }

  if (route === "unknown" || route === "instant" || route === "batched") {
    reasons.push(`settlement mode ${route} is not Phase 3 supported`);
    return baseTarget(agent, tier, "unsupported_settlement", reasons);
  }

  if (!agent.identity?.x402Endpoint && route === "x402") {
    reasons.push("x402 tier but no x402 endpoint");
    return baseTarget(agent, tier, "missing_endpoint", reasons);
  }

  if (priceUsdc === 0) {
    reasons.push("free tier; useful for behavior checks but weaker for payment proof");
    return baseTarget(agent, tier, "free", reasons);
  }

  if (priceSol === 0) {
    reasons.push("free tier; useful for behavior checks but weaker for payment proof");
    return baseTarget(agent, tier, "free", reasons);
  }

  if (priceUsdc !== null && priceUsdc > maxCostUsdc) {
    reasons.push(`estimated cost ${priceUsdc} USDC exceeds max ${maxCostUsdc}`);
    return baseTarget(agent, tier, "too_expensive", reasons);
  }

  if (priceSol !== null && priceSol > 0.00035) {
    reasons.push(`SOL price ${priceSol} exceeds Phase 3 cap 0.00035 SOL`);
    return baseTarget(agent, tier, "too_expensive", reasons);
  }

  reasons.push("active, priced, endpoint present, and within budget");
  const target = baseTarget(agent, tier, "good_audit_target", reasons);
  target.pricePerCallDisplay = display;
  return target;
}

function baseTarget(agent: SapAgentRecord, tier: PricingTier | null, status: PlannedTarget["status"], reasons: string[]): PlannedTarget {
  const identity = agent.identity ?? {};
  const token = tier ? tokenLabel(tier) : "unknown";
  return {
    name: identity.name ?? "Unnamed SAP Agent",
    pda: agent.pda,
    wallet: identity.wallet ?? null,
    endpoint: identity.x402Endpoint ?? identity.agentUri ?? null,
    agentUri: identity.agentUri ?? null,
    protocolIds: identity.protocols ?? [],
    capabilitiesCount: identity.capabilities?.length ?? 0,
    pricingTier: tier?.tierId ?? null,
    route: tier ? settlementRoute(tier) : "unknown",
    token,
    pricePerCall: tier?.pricePerCall ?? null,
    pricePerCallDisplay: tier ? priceDisplay(tier, token) : null,
    status,
    reasons,
  };
}

function tokenLabel(tier: PricingTier): string {
  const tokenType = tier.tokenType ?? {};
  if ("usdc" in tokenType) return "USDC";
  if ("sol" in tokenType) return "SOL";
  if ("spl" in tokenType) return tier.tokenMint ? `SPL:${tier.tokenMint}` : "SPL";
  return tier.tokenMint ? `SPL:${tier.tokenMint}` : "unknown";
}

function settlementRoute(tier: PricingTier): PlannedTarget["route"] {
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
  if (token === "SOL") return null;
  return null;
}

function estimatedSol(tier: PricingTier, token: string): number | null {
  if (!tier.pricePerCall || token !== "SOL") return null;
  const decimals = decimalsFor(tier, token);
  return Number(tier.pricePerCall) / 10 ** decimals;
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

function decimalsFor(tier: PricingTier, token: string): number {
  if (typeof tier.tokenDecimals === "number") return tier.tokenDecimals;
  if (token === "USDC" || token.startsWith("SPL:")) return 6;
  if (token === "SOL") return 9;
  return 9;
}

function compareTargets(a: PlannedTarget, b: PlannedTarget): number {
  if (a.status !== b.status) return a.status === "good_audit_target" ? -1 : 1;
  return (a.pricePerCallDisplay ?? "").localeCompare(b.pricePerCallDisplay ?? "");
}

function countStatuses(targets: PlannedTarget[]): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const target of targets) {
    counts[target.status] = (counts[target.status] ?? 0) + 1;
  }
  return counts;
}

async function writeJson(path: string, value: unknown): Promise<string> {
  const outputPath = resolve(path);
  await mkdir(dirname(outputPath), { recursive: true });
  await writeFile(outputPath, `${JSON.stringify(value, null, 2)}\n`, "utf8");
  return outputPath;
}

main().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : String(error);
  const stack = error instanceof Error ? error.stack : undefined;
  console.error(
    JSON.stringify({
      level: "error",
      message: "SAP discovery failed",
      error: message,
      stack,
      timestamp: new Date().toISOString(),
    }),
  );
  process.exitCode = 1;
});
