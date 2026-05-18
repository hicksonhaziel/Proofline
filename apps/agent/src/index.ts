import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { LocalStore } from "../../../packages/db/src/index.js";
import { loadConfig, safeConfigSummary } from "./config.js";
import { createLogger } from "./logger.js";

async function main(): Promise<void> {
  const runId = `run_${randomUUID()}`;
  const logger = createLogger(runId);

  logger.info("Proofline agent starting");

  const config = loadConfig();
  logger.info("Loaded config", safeConfigSummary(config));

  const sapKeypairPath = resolve(config.sapKeypairPath);
  logger.info("Checked SAP keypair path", {
    sapKeypairPath,
    exists: existsSync(sapKeypairPath),
  });

  const store = new LocalStore({
    targetsFile: config.targetAgentList,
    proofPacketsDir: "data/proof-packets",
    artifactsDir: "data/artifacts",
    runsDir: "data/runs",
  });

  await store.ensureDirectories();

  const targets = await store.readSeedTargets();
  logger.info("Loaded seed targets", {
    targetCount: targets.length,
    source: config.targetAgentList,
  });

  const runStatePath = await store.writeRunState(runId, {
    runId,
    phase: 1,
    mode: "safe_startup",
    startedAt: new Date().toISOString(),
    targetCount: targets.length,
    flags: config.flags,
    note: "Phase 1 only validates local setup. No SAP, Ace, Sentinel, x402, escrow, or payment calls are executed.",
  });

  logger.info("Wrote run state", { runStatePath });
  logger.info("Proofline Phase 1 startup complete; no paid calls were made");
}

main().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : String(error);
  console.error(
    JSON.stringify({
      level: "error",
      message: "Proofline agent failed during startup",
      error: message,
      timestamp: new Date().toISOString(),
    }),
  );
  process.exitCode = 1;
});

