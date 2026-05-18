import { Connection } from "@solana/web3.js";
import { loadConfig, safeConfigSummary } from "./config.js";
import { createLogger } from "./logger.js";

async function main(): Promise<void> {
  const logger = createLogger(`rpc_check_${Date.now()}`);
  const config = loadConfig();

  logger.info("Checking configured RPC endpoints", safeConfigSummary(config));

  await checkRpc("SYNAPSE_RPC_URL", config.synapseRpcUrl, logger);
  await checkRpc("SOLANA_RPC_URL", config.solanaRpcUrl, logger);
}

async function checkRpc(
  name: string,
  url: string,
  logger: ReturnType<typeof createLogger>,
): Promise<void> {
  const connection = new Connection(url, "confirmed");
  const version = await connection.getVersion();
  const slot = await connection.getSlot("confirmed");

  logger.info("RPC endpoint is reachable", {
    name,
    slot,
    version,
  });
}

main().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : String(error);
  console.error(
    JSON.stringify({
      level: "error",
      message: "RPC check failed",
      error: message,
      timestamp: new Date().toISOString(),
    }),
  );
  process.exitCode = 1;
});

