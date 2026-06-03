import { loadConfig, safeConfigSummary } from "./config.js";
import { createLogger } from "./logger.js";

interface BuyerArgs {
  tool: "get_execution_verdict" | "get_execution_proof" | "list_recent_proofs";
  proofPacketId?: string;
  targetAgentId?: string;
  sendPaymentHeader: boolean;
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv);
  const config = loadConfig();
  const logger = createLogger(`buyer_demo_${Date.now()}`);
  const baseUrl = config.publicBaseUrl.replace(/\/$/, "");
  const metadata = await getJson(`${baseUrl}/x402`);
  const url = new URL(`${baseUrl}/x402/${args.tool}`);
  if (args.proofPacketId) url.searchParams.set("proofPacketId", args.proofPacketId);
  if (args.targetAgentId) url.searchParams.set("targetAgentId", args.targetAgentId);

  logger.info("Starting Proofline buyer demo", {
    config: safeConfigSummary(config),
    tool: args.tool,
    endpoint: url.toString(),
    paymentMode: args.sendPaymentHeader ? "captured_header_demo" : "discovery_demo",
    metadataStatus: metadata.status,
  });

  const headers: Record<string, string> = {
    "x-buyer-wallet": "buyer_demo_agent",
  };
  if (args.sendPaymentHeader) {
    headers["X-PAYMENT"] = Buffer.from(
      JSON.stringify({
        scheme: "demo",
        note: "Buyer demo header only. This is not a facilitator-settled x402 payment.",
        createdAt: new Date().toISOString(),
      }),
    ).toString("base64");
  }

  const response = await fetch(url, { headers });
  const payload = await readJsonOrText(response);
  logger.info("Proofline buyer demo complete", {
    status: response.status,
    ok: response.ok,
    saleId: isRecord(payload) && isRecord(payload.sale) ? payload.sale.sale_id : undefined,
    payment: isRecord(payload) ? payload.payment : undefined,
    preview: JSON.stringify(payload).slice(0, 1200),
  });

  if (!response.ok) {
    throw new Error(`Buyer demo failed with HTTP ${response.status}`);
  }
}

function parseArgs(argv: string[]): BuyerArgs {
  const tool = valueAfter(argv, "--tool") ?? "get_execution_verdict";
  if (tool !== "get_execution_verdict" && tool !== "get_execution_proof" && tool !== "list_recent_proofs") {
    throw new Error("--tool must be get_execution_verdict, get_execution_proof, or list_recent_proofs");
  }
  const out: BuyerArgs = {
    tool,
    sendPaymentHeader: argv.includes("--send-payment-header"),
  };
  const proofPacketId = valueAfter(argv, "--proof");
  const targetAgentId = valueAfter(argv, "--target-agent");
  if (proofPacketId) out.proofPacketId = proofPacketId;
  if (targetAgentId) out.targetAgentId = targetAgentId;
  return out;
}

async function getJson(url: string): Promise<Record<string, unknown>> {
  const response = await fetch(url);
  const payload = await readJsonOrText(response);
  if (!response.ok) throw new Error(`GET ${url} failed with HTTP ${response.status}: ${JSON.stringify(payload)}`);
  return isRecord(payload) ? payload : {};
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

function valueAfter(argv: string[], name: string): string | undefined {
  const index = argv.indexOf(name);
  const value = index >= 0 ? argv[index + 1] : undefined;
  return value && !value.startsWith("--") ? value : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

main().catch((error: unknown) => {
  console.error(
    JSON.stringify({
      level: "error",
      message: "Proofline buyer demo failed",
      error: error instanceof Error ? error.message : String(error),
      timestamp: new Date().toISOString(),
    }),
  );
  process.exitCode = 1;
});
