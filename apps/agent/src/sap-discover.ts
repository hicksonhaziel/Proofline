import { loadConfig } from "./config.js";
import {
  runDiscovery,
  SapDiscoveryProvider,
  SeedDiscoveryProvider,
} from "./discovery.js";
import { createLogger } from "./logger.js";
import { createProoflineStore } from "./storage.js";

async function main(): Promise<void> {
  const runId = `sap_discover_${Date.now()}`;
  const logger = createLogger(runId);
  const config = loadConfig();
  const store = createProoflineStore(config);
  await store.ensureReady();

  logger.info("Starting SAP discovery", {
    explorerApi: "https://explorer.oobeprotocol.ai/api/sap/agents",
    maxCostUsdc: config.limits.maxSpendPerAuditUsdc,
    minReauditIntervalHours: config.limits.minReauditIntervalHours,
  });

  const snapshot = await runDiscovery({
    context: {
      maxCostUsdc: config.limits.maxSpendPerAuditUsdc,
      minReauditIntervalHours: config.limits.minReauditIntervalHours,
    },
    store,
    providers: [
      new SapDiscoveryProvider(),
      new SeedDiscoveryProvider([
        "data/targets.json",
        config.targetAgentList,
      ]),
    ],
  });

  logger.info("SAP discovery complete", {
    totalCandidates: snapshot.totalCandidates,
    uniqueTargets: snapshot.uniqueTargets,
    recommendedTargets: snapshot.recommendedTargets.length,
    queuedAuditJobs: snapshot.queue.totalJobs,
    providerCounts: snapshot.providerCounts,
    counts: snapshot.counts,
    queuePath: snapshot.queue.path,
  });

  for (const target of snapshot.recommendedTargets.slice(0, 8)) {
    logger.info("Recommended audit target", {
      name: target.name,
      agentId: target.agentId,
      toolId: target.toolId,
      route: target.route,
      token: target.token,
      price: target.pricePerCallDisplay,
      endpoint: target.endpoint,
      priorityScore: target.priorityScore,
      status: target.status,
    });
  }
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
