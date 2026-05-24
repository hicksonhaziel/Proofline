import { mkdir, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { loadConfig, safeConfigSummary } from "./config.js";
import { loadKeypairFromFile } from "./keypair.js";
import { createLogger } from "./logger.js";

interface CliArgs {
  toolName: string;
}

interface HttpResult {
  url: string;
  method: string;
  status: number | null;
  ok: boolean;
  headers: Record<string, string>;
  body: unknown;
  latencyMs: number;
  error?: string;
}

interface SentinelServiceRecord {
  generatedAt: string;
  sentinel: {
    wallet: string;
    agentPda: string;
    baseUrl: string;
    selectedTool: string;
  };
  prooflineWallet: string;
  calls: {
    health: HttpResult;
    profile: HttpResult;
    tools: HttpResult;
    unpaidToolCall: HttpResult;
    depositorToolCall: HttpResult;
  };
  conclusion: {
    serviceReached: boolean;
    realToolReached: boolean;
    paymentRequired: boolean;
    escrowFunded: boolean;
    minEscrowDepositLamports: number | null;
    minEscrowDepositSol: number | null;
    pricePerCallLamports: number | null;
    notes: string[];
  };
}

const SENTINEL_BASE_URL = "https://agent.sentinel.oobeprotocol.ai";
const SENTINEL_AGENT_PDA = "AzqhCKhku9TX3ScVtQw5nffLJ6PoA8r3P6HiTdinuAKz";
const DEFAULT_TOOL = "spl-token_getBalance";
const OUTPUT_PATH = "data/sentinel/latest.json";

async function main(): Promise<void> {
  const args = parseArgs(process.argv);
  const runId = `sentinel_check_${Date.now()}`;
  const logger = createLogger(runId);
  const config = loadConfig();
  const keypair = await loadKeypairFromFile(config.sapKeypairPath);
  const wallet = keypair.publicKey.toBase58();

  logger.info("Starting Synapse Sentinel service check", {
    config: safeConfigSummary(config),
    selectedTool: args.toolName,
    sentinelBaseUrl: SENTINEL_BASE_URL,
  });

  const health = await request("GET", `${SENTINEL_BASE_URL}/health`);
  const profile = await request("GET", `${SENTINEL_BASE_URL}/agent`);
  const tools = await request("GET", `${SENTINEL_BASE_URL}/tools`);
  const body = {
    wallet,
  };
  const unpaidToolCall = await request("POST", `${SENTINEL_BASE_URL}/tools/${args.toolName}`, body);
  const depositorToolCall = await request("POST", `${SENTINEL_BASE_URL}/tools/${args.toolName}`, body, {
    "x-sap-depositor": wallet,
  });

  const paymentBody = firstRecord(depositorToolCall.body, unpaidToolCall.body);
  const minEscrowDepositLamports = numberField(paymentBody, "minEscrowDeposit");
  const pricePerCallLamports = numberField(paymentBody, "pricePerCall");
  const paymentRequired = unpaidToolCall.status === 402 || depositorToolCall.status === 402;
  const escrowFunded = depositorToolCall.ok && depositorToolCall.status !== 402;
  const realToolReached = isRecord(unpaidToolCall.body) && (
    unpaidToolCall.body.error === "payment_required" ||
    unpaidToolCall.body.error === "escrow_not_funded" ||
    unpaidToolCall.ok
  );

  const record: SentinelServiceRecord = {
    generatedAt: new Date().toISOString(),
    sentinel: {
      wallet: config.sentinelAgentId,
      agentPda: SENTINEL_AGENT_PDA,
      baseUrl: SENTINEL_BASE_URL,
      selectedTool: args.toolName,
    },
    prooflineWallet: wallet,
    calls: {
      health,
      profile,
      tools,
      unpaidToolCall,
      depositorToolCall,
    },
    conclusion: {
      serviceReached: (health.ok || profile.ok) && realToolReached,
      realToolReached,
      paymentRequired,
      escrowFunded,
      minEscrowDepositLamports,
      minEscrowDepositSol: minEscrowDepositLamports === null ? null : minEscrowDepositLamports / 1_000_000_000,
      pricePerCallLamports,
      notes: [
        "This check calls the live Synapse Sentinel service and a real Sentinel tool endpoint.",
        "No escrow is opened and no SOL/USDC is spent by this script.",
        paymentRequired
          ? "Sentinel requires a funded SAP x402 escrow before it will execute the selected tool."
          : "Sentinel did not require payment for the selected tool in this run.",
        escrowFunded
          ? "The depositor call appears funded/executable."
          : "The depositor call is not funded yet, so this is not a completed paid Sentinel execution.",
      ],
    },
  };

  const outputPath = await writeJson(OUTPUT_PATH, record);
  logger.info("Synapse Sentinel service check complete", {
    outputPath,
    serviceReached: record.conclusion.serviceReached,
    realToolReached: record.conclusion.realToolReached,
    paymentRequired: record.conclusion.paymentRequired,
    escrowFunded: record.conclusion.escrowFunded,
    minEscrowDepositSol: record.conclusion.minEscrowDepositSol,
    pricePerCallLamports: record.conclusion.pricePerCallLamports,
  });
}

function parseArgs(argv: string[]): CliArgs {
  const toolIndex = argv.findIndex((arg) => arg === "--tool");
  const toolName = toolIndex >= 0 ? argv[toolIndex + 1] : DEFAULT_TOOL;
  if (!toolName || toolName.startsWith("--")) {
    throw new Error("--tool must be followed by a Sentinel tool name");
  }
  return { toolName };
}

async function request(method: "GET" | "POST", url: string, body?: unknown, headers: Record<string, string> = {}): Promise<HttpResult> {
  const startedAt = Date.now();
  try {
    const init: RequestInit = {
      method,
      headers: {
        accept: "application/json, text/plain;q=0.9, */*;q=0.8",
        ...(body ? { "content-type": "application/json" } : {}),
        ...headers,
      },
      signal: AbortSignal.timeout(20000),
    };
    if (body) {
      init.body = JSON.stringify(body);
    }

    const response = await fetch(url, init);

    return {
      url,
      method,
      status: response.status,
      ok: response.ok,
      headers: Object.fromEntries(response.headers.entries()),
      body: await parseBody(response),
      latencyMs: Date.now() - startedAt,
    };
  } catch (error) {
    return {
      url,
      method,
      status: null,
      ok: false,
      headers: {},
      body: null,
      latencyMs: Date.now() - startedAt,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

async function parseBody(response: Response): Promise<unknown> {
  const text = await response.text();
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return text;
  }
}

function firstRecord(...values: unknown[]): Record<string, unknown> | null {
  for (const value of values) {
    if (isRecord(value)) return value;
  }
  return null;
}

function numberField(record: Record<string, unknown> | null, key: string): number | null {
  const value = record?.[key];
  return typeof value === "number" && Number.isFinite(value) ? value : null;
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

main().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : String(error);
  const stack = error instanceof Error ? error.stack : undefined;
  console.error(
    JSON.stringify({
      level: "error",
      message: "Synapse Sentinel service check failed",
      error: message,
      stack,
      timestamp: new Date().toISOString(),
    }),
  );
  process.exitCode = 1;
});
