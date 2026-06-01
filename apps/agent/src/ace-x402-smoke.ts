import { mkdir, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { AceDataCloudClient, extractAceChatContent, type AceServiceResult } from "../../../packages/integrations/src/index.js";
import { loadConfig, safeConfigSummary } from "./config.js";
import { createLogger } from "./logger.js";

type SmokeService = "chat" | "search" | "translate";

interface SmokeArgs {
  services: SmokeService[];
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv);
  const runId = `ace_x402_smoke_${Date.now()}`;
  const logger = createLogger(runId);
  const config = loadConfig();
  const paymentMode = process.env.PAYMENT_MODE === "send" && process.env.PAYMENT_CONFIRM_SPEND === "true" ? "send" : "dry-run";

  logger.info("Starting Ace x402 smoke test", {
    services: args.services,
    paymentMode,
    config: safeConfigSummary(config),
    note:
      paymentMode === "send"
        ? "This run will sign X-Payment and can spend Base USDC."
        : "Dry-run only: this run requests Ace x402 quotes but does not send X-Payment.",
  });

  if (!config.aceX402WalletKey) {
    throw new Error("ACE_X402_WALLET_KEY is required for Ace x402 smoke tests.");
  }

  const client = new AceDataCloudClient({
    x402WalletKey: config.aceX402WalletKey,
    x402PaymentMode: paymentMode,
    x402PreferScheme: "exact",
    maxSpendPerRequestUsdc: config.limits.maxSpendPerAuditUsdc,
    maxTotalSpendUsdc: config.limits.maxSpendPerAuditUsdc,
    timeoutMs: Number(process.env.ACE_TIMEOUT_MS ?? 120000),
  });

  const results: AceServiceResult[] = [];

  for (const service of args.services) {
    const result = await runService(client, service);
    results.push(result);
    logger.info("Ace x402 service result", {
      service: result.service,
      ok: result.ok,
      status: result.status,
      error: result.error,
      x402: result.x402
        ? {
            status: result.x402.status,
            network: result.x402.network,
            scheme: result.x402.scheme,
            amount: result.x402.amount,
            asset: result.x402.asset,
            payTo: result.x402.payTo,
            transactionHash: result.x402.transactionHash,
          }
        : null,
      preview: previewResult(result),
    });
  }

  const outputPath = resolve("data/artifacts", runId, "ace-x402-smoke.json");
  await writeJson(outputPath, {
    runId,
    paymentMode,
    services: args.services,
    results: results.map((result) => ({
      service: result.service,
      endpoint: result.endpoint,
      ok: result.ok,
      status: result.status,
      latencyMs: result.latencyMs,
      error: result.error,
      x402: result.x402,
      preview: previewResult(result),
    })),
    createdAt: new Date().toISOString(),
  });

  logger.info("Ace x402 smoke test complete", { outputPath });
}

async function runService(client: AceDataCloudClient, service: SmokeService): Promise<AceServiceResult> {
  if (service === "chat") {
    return client.chatJson(
      [
        {
          role: "user",
          content: "Return a tiny JSON object with keys status and message. Message should be 'Proofline x402 paid request works'.",
        },
      ],
      "Return strict JSON only.",
    );
  }

  if (service === "search") {
    return client.search({
      query: "Proofline SAP agent x402 Ace Data Cloud",
      number: 3,
      country: "US",
      language: "en",
    });
  }

  return client.translate({
    input: "Proofline x402 paid request works.",
    locale: "es-ES",
    extension: "md",
  });
}

function parseArgs(argv: string[]): SmokeArgs {
  const serviceArg = valueAfter(argv, "--service");
  if (!serviceArg || serviceArg === "chat") return { services: ["chat"] };
  if (serviceArg === "all") return { services: ["chat", "search", "translate"] };
  if (serviceArg === "search" || serviceArg === "translate") return { services: [serviceArg] };
  throw new Error("--service must be one of: chat, search, translate, all");
}

function valueAfter(argv: string[], name: string): string | undefined {
  const index = argv.indexOf(name);
  if (index === -1) return undefined;
  return argv[index + 1];
}

function previewResult(result: AceServiceResult): unknown {
  if (result.service === "ace_openai_chat_completions") {
    return extractAceChatContent(result.data).slice(0, 500);
  }

  return trimLargePayload(result.data);
}

function trimLargePayload(value: unknown): unknown {
  if (typeof value === "string") {
    return value.length > 500 ? `${value.slice(0, 500)}...[trimmed ${value.length - 500} chars]` : value;
  }

  if (Array.isArray(value)) {
    return value.slice(0, 5).map(trimLargePayload);
  }

  if (!isRecord(value)) {
    return value;
  }

  const output: Record<string, unknown> = {};
  for (const [key, item] of Object.entries(value).slice(0, 20)) {
    output[key] = trimLargePayload(item);
  }
  return output;
}

async function writeJson(path: string, value: unknown): Promise<string> {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, `${JSON.stringify(value, null, 2)}\n`, "utf8");
  return path;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

main().catch((error: unknown) => {
  console.error(
    JSON.stringify({
      level: "error",
      message: "Ace x402 smoke test failed",
      error: error instanceof Error ? error.message : String(error),
      timestamp: new Date().toISOString(),
    }),
  );
  process.exitCode = 1;
});
