import { createHash } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { PublicKey } from "@solana/web3.js";
import { prooflineAgentMetadata } from "../../../packages/core/src/index.js";
import { loadSapSdk } from "../../../packages/integrations/src/index.js";
import { loadConfig, safeConfigSummary } from "./config.js";
import { loadKeypairFromFile } from "./keypair.js";
import { createLogger } from "./logger.js";

type RegistrationMode = "dry-run" | "send";

interface RegistrationRecord {
  mode: RegistrationMode;
  status: "simulated" | "submitted";
  wallet: string;
  agentPda: string;
  agentStatsPda: string;
  globalPda: string;
  programId: string;
  signature?: string;
  simulatedAt?: string;
  submittedAt?: string;
  metadata: typeof prooflineAgentMetadata;
  toolPdas: Record<string, string>;
  notes: string[];
}

async function main(): Promise<void> {
  const mode = parseMode(process.argv);
  const runId = `sap_register_${Date.now()}`;
  const logger = createLogger(runId);
  const config = loadConfig();

  logger.info("Starting SAP registration script", {
    mode,
    config: safeConfigSummary(config),
  });

  const sdk = loadSapSdk();
  const keypair = await loadKeypairFromFile(config.sapKeypairPath);
  const wallet = keypair.publicKey;
  const client = new sdk.SapClient({
    rpcUrl: config.synapseRpcUrl,
    commitment: "confirmed",
  });

  const [agentPda] = sdk.Pdas.getAgentPDA(wallet) as [PublicKey, number];
  const [agentStatsPda] = deriveAgentStatsPda(agentPda, String(sdk.PROGRAM_ID));
  const [globalPda] = sdk.Pdas.getGlobalPDA() as [PublicKey, number];

  const balanceLamports = await client.connection.getBalance(wallet);
  logger.info("Loaded SAP wallet", {
    wallet: wallet.toBase58(),
    balanceSol: balanceLamports / 1_000_000_000,
    agentPda: agentPda.toBase58(),
  });

  const registerInstruction = await client.agent.registerAgent({
    signer: keypair,
    wallet,
    agent: agentPda,
    agentStats: agentStatsPda,
    globalRegistry: globalPda,
    name: prooflineAgentMetadata.name,
    description: prooflineAgentMetadata.description,
    capabilities: prooflineAgentMetadata.capabilities,
    pricing: [],
    protocols: prooflineAgentMetadata.protocols,
    agentId: prooflineAgentMetadata.agentId,
    agentUri: config.prooflineAgentUri ?? null,
    x402Endpoint: config.prooflineX402Endpoint ?? null,
  });

  const tx = await client.buildTransaction([registerInstruction], wallet);
  tx.sign([keypair]);

  const simulation = await client.connection.simulateTransaction(tx);

  if (simulation.value.err) {
    logger.error("SAP registration simulation failed", {
      simulationError: simulation.value.err,
      logs: simulation.value.logs ?? [],
    });
    process.exitCode = 1;
    return;
  }

  logger.info("SAP registration simulation passed", {
    logs: simulation.value.logs?.slice(-5) ?? [],
  });

  const toolPdas = Object.fromEntries(
    prooflineAgentMetadata.tools.map((tool) => {
      const [toolPda] = sdk.Pdas.getToolPDA(agentPda, tool.name) as [PublicKey, number];
      return [tool.name, toolPda.toBase58()];
    }),
  );

  const record: RegistrationRecord = {
    mode,
    status: mode === "send" ? "submitted" : "simulated",
    wallet: wallet.toBase58(),
    agentPda: agentPda.toBase58(),
    agentStatsPda: agentStatsPda.toBase58(),
    globalPda: globalPda.toBase58(),
    programId: String(sdk.PROGRAM_ID),
    simulatedAt: new Date().toISOString(),
    metadata: prooflineAgentMetadata,
    toolPdas,
    notes: [
      "The SAP SDK package has a broken ESM export on Node 22, so Proofline loads its CommonJS export via createRequire.",
      "Phase 2 registers the agent identity. Tool publishing is kept as explicit follow-up because the current SDK exposes low-level hash-based publishTool calls.",
    ],
  };

  if (mode === "send") {
    const signature = await client.connection.sendTransaction(tx, {
      preflightCommitment: "confirmed",
      maxRetries: 3,
    });

    record.signature = signature;
    record.submittedAt = new Date().toISOString();
    logger.info("SAP registration transaction submitted", { signature });
  } else {
    logger.warn("Dry-run only; rerun with --send to submit the SAP registration transaction");
  }

  const outputPath = await writeRegistrationRecord(record);
  logger.info("Saved SAP registration record", { outputPath });
}

function parseMode(argv: string[]): RegistrationMode {
  return argv.includes("--send") ? "send" : "dry-run";
}

function deriveAgentStatsPda(agentPda: PublicKey, programId: string): [PublicKey, number] {
  return PublicKey.findProgramAddressSync(
    [Buffer.from("sap_stats"), agentPda.toBuffer()],
    new PublicKey(programId),
  );
}

async function writeRegistrationRecord(record: RegistrationRecord): Promise<string> {
  const outputPath = resolve("data/sap/registration.json");
  await mkdir(dirname(outputPath), { recursive: true });
  await writeFile(outputPath, `${JSON.stringify(record, null, 2)}\n`, "utf8");

  const manifestPath = resolve("data/sap/tools.manifest.json");
  await writeFile(
    manifestPath,
    `${JSON.stringify(
      {
        generatedAt: new Date().toISOString(),
        metadataHash: createHash("sha256").update(JSON.stringify(prooflineAgentMetadata)).digest("hex"),
        tools: prooflineAgentMetadata.tools,
      },
      null,
      2,
    )}\n`,
    "utf8",
  );

  return outputPath;
}

main().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : String(error);
  const stack = error instanceof Error ? error.stack : undefined;
  console.error(
    JSON.stringify({
      level: "error",
      message: "SAP registration script failed",
      error: message,
      stack,
      timestamp: new Date().toISOString(),
    }),
  );
  process.exitCode = 1;
});
