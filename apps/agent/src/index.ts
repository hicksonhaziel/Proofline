import { loadConfig, safeConfigSummary } from "./config.js";
import { createLogger } from "./logger.js";
import { parseSchedulerArgs, runScheduler } from "./scheduler.js";

async function main(): Promise<void> {
  const config = loadConfig();
  const options = parseSchedulerArgs(process.argv);
  const logger = createLogger("agent_startup");

  logger.info("Proofline agent starting", {
    config: safeConfigSummary(config),
    scheduler: options,
    paymentMode: process.env.PAYMENT_MODE ?? "dry-run",
    paymentConfirmSpend: process.env.PAYMENT_CONFIRM_SPEND === "true",
  });

  await runScheduler(config, options);
}

main().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : String(error);
  const stack = error instanceof Error ? error.stack : undefined;
  console.error(
    JSON.stringify({
      level: "error",
      message: "Proofline agent failed",
      error: message,
      stack,
      timestamp: new Date().toISOString(),
    }),
  );
  process.exitCode = 1;
});
