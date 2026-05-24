import { createHash } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { PublicKey } from "@solana/web3.js";
import { prooflineAgentMetadata, type ProoflineToolDefinition } from "../../../packages/core/src/index.js";
import { loadSapSdk } from "../../../packages/integrations/src/index.js";
import { loadConfig, safeConfigSummary } from "./config.js";
import { loadKeypairFromFile } from "./keypair.js";
import { createLogger } from "./logger.js";

type PublishMode = "dry-run" | "send";

interface PublishRecord {
  mode: PublishMode;
  status: "simulated" | "submitted" | "skipped";
  wallet: string;
  agentPda: string;
  globalPda: string;
  programId: string;
  selectedTools: PublishedToolRecord[];
  skippedTools: Array<{ name: string; reason: string; toolPda?: string }>;
  signature?: string;
  simulatedAt: string;
  submittedAt?: string;
  notes: string[];
}

interface PublishedToolRecord {
  name: string;
  toolPda: string;
  protocolHash: string;
  descriptionHash: string;
  inputSchemaHash: string;
  outputSchemaHash: string;
  httpMethod: number;
  category: number;
  paramsCount: number;
  requiredParams: number;
}

const DEFAULT_TOOLS = ["audit_agent", "get_execution_proof"];
const TOOL_CATEGORY_VALUES: Record<string, number> = {
  swap: 0,
  lend: 1,
  stake: 2,
  nft: 3,
  payment: 4,
  data: 5,
  governance: 6,
  bridge: 7,
  analytics: 8,
  custom: 9,
  audit: 8,
  proof: 5,
};

const HTTP_METHOD_VALUES: Record<string, number> = {
  get: 0,
  post: 1,
  put: 2,
  delete: 3,
  compound: 4,
};

async function main(): Promise<void> {
  const args = parseArgs(process.argv);
  const runId = `sap_publish_tools_${Date.now()}`;
  const logger = createLogger(runId);
  const config = loadConfig();

  logger.info("Starting SAP tool publishing script", {
    mode: args.mode,
    selectedToolNames: args.selectedToolNames,
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
  const [globalPda] = sdk.Pdas.getGlobalPDA() as [PublicKey, number];
  const balanceLamports = await client.connection.getBalance(wallet);

  logger.info("Loaded SAP wallet", {
    wallet: wallet.toBase58(),
    balanceSol: balanceLamports / 1_000_000_000,
    agentPda: agentPda.toBase58(),
  });

  const selectedTools = selectTools(args.selectedToolNames);
  const selectedRecords: PublishedToolRecord[] = [];
  const skippedTools: PublishRecord["skippedTools"] = [];
  const instructions: unknown[] = [];

  for (const tool of selectedTools) {
    const record = buildToolRecord(tool, agentPda, String(sdk.PROGRAM_ID));
    const existingAccount = await safeGetAccountInfo(client, new PublicKey(record.toolPda), logger);

    if (existingAccount) {
      skippedTools.push({ name: tool.name, reason: "tool account already exists", toolPda: record.toolPda });
      continue;
    }

    const instruction = await client.tools.publishTool({
      signer: keypair,
      wallet,
      agent: agentPda,
      tool: new PublicKey(record.toolPda),
      globalRegistry: globalPda,
      toolName: tool.name,
      toolNameHash: hashArray(tool.name),
      protocolHash: hexToArray(record.protocolHash),
      descriptionHash: hexToArray(record.descriptionHash),
      inputSchemaHash: hexToArray(record.inputSchemaHash),
      outputSchemaHash: hexToArray(record.outputSchemaHash),
      httpMethod: record.httpMethod,
      category: record.category,
      paramsCount: tool.paramsCount,
      requiredParams: tool.requiredParams,
      isCompound: false,
    });

    instructions.push(instruction);
    selectedRecords.push(record);
  }

  const record: PublishRecord = {
    mode: args.mode,
    status: instructions.length === 0 ? "skipped" : args.mode === "send" ? "submitted" : "simulated",
    wallet: wallet.toBase58(),
    agentPda: agentPda.toBase58(),
    globalPda: globalPda.toBase58(),
    programId: String(sdk.PROGRAM_ID),
    selectedTools: selectedRecords,
    skippedTools,
    simulatedAt: new Date().toISOString(),
    notes: [
      "Tool PDAs are derived from sha256(toolName), matching the SDK AgentBuilder implementation.",
      "Default Phase 3 publish set is limited to audit_agent and get_execution_proof to preserve SOL.",
    ],
  };

  if (instructions.length === 0) {
    const outputPath = await writePublishRecord(record);
    logger.warn("No publish instructions were built", { skippedTools, outputPath });
    return;
  }

  const tx = await client.buildTransaction(instructions, wallet);
  tx.sign([keypair]);

  const simulation = await client.connection.simulateTransaction(tx);

  if (simulation.value.err) {
    logger.error("SAP tool publishing simulation failed", {
      simulationError: simulation.value.err,
      logs: simulation.value.logs ?? [],
    });
    await writePublishRecord(record);
    process.exitCode = 1;
    return;
  }

  logger.info("SAP tool publishing simulation passed", {
    selectedTools: selectedRecords.map((tool) => ({ name: tool.name, toolPda: tool.toolPda })),
    logs: simulation.value.logs?.slice(-8) ?? [],
  });

  if (args.mode === "send") {
    const signature = await client.connection.sendTransaction(tx, {
      preflightCommitment: "confirmed",
      maxRetries: 3,
    });

    record.signature = signature;
    record.submittedAt = new Date().toISOString();
    logger.info("SAP tool publishing transaction submitted", { signature });
  } else {
    logger.warn("Dry-run only; rerun with --send to submit the tool publishing transaction");
  }

  const outputPath = await writePublishRecord(record);
  logger.info("Saved SAP tool publishing record", { outputPath });
}

function parseArgs(argv: string[]): { mode: PublishMode; selectedToolNames: string[] } {
  const mode: PublishMode = argv.includes("--send") ? "send" : "dry-run";
  const toolsArgIndex = argv.findIndex((arg) => arg === "--tools");
  const toolsCsv = toolsArgIndex >= 0 ? argv[toolsArgIndex + 1] : undefined;
  const selectedToolNames = toolsCsv
    ? toolsCsv.split(",").map((tool) => tool.trim()).filter(Boolean)
    : DEFAULT_TOOLS;

  if (selectedToolNames.length === 0) {
    throw new Error("At least one tool name must be selected");
  }

  return { mode, selectedToolNames };
}

function selectTools(selectedToolNames: string[]): ProoflineToolDefinition[] {
  const byName = new Map(prooflineAgentMetadata.tools.map((tool) => [tool.name, tool]));
  return selectedToolNames.map((name) => {
    const tool = byName.get(name);
    if (!tool) {
      throw new Error(`Unknown Proofline tool: ${name}`);
    }
    return tool;
  });
}

function buildToolRecord(tool: ProoflineToolDefinition, agentPda: PublicKey, programId: string): PublishedToolRecord {
  const toolNameHash = hashBuffer(tool.name);
  const [toolPda] = PublicKey.findProgramAddressSync(
    [Buffer.from("sap_tool"), agentPda.toBuffer(), toolNameHash],
    new PublicKey(programId),
  );
  const inputSchema = {
    type: "object",
    tool: tool.name,
    requiredParams: tool.requiredParams,
    paramsCount: tool.paramsCount,
  };
  const outputSchema = {
    type: "object",
    tool: tool.name,
    returns: tool.name === "audit_agent" ? "ExecutionProofPacket" : "ProoflineResponse",
  };

  return {
    name: tool.name,
    toolPda: toolPda.toBase58(),
    protocolHash: hashHex(tool.protocolId),
    descriptionHash: hashHex(tool.description),
    inputSchemaHash: hashHex(JSON.stringify(inputSchema)),
    outputSchemaHash: hashHex(JSON.stringify(outputSchema)),
    httpMethod: HTTP_METHOD_VALUES[tool.httpMethod] ?? HTTP_METHOD_VALUES.post ?? 1,
    category: TOOL_CATEGORY_VALUES[tool.category] ?? TOOL_CATEGORY_VALUES.custom ?? 9,
    paramsCount: tool.paramsCount,
    requiredParams: tool.requiredParams,
  };
}

function hashBuffer(value: string): Buffer {
  return createHash("sha256").update(value).digest();
}

function hashHex(value: string): string {
  return hashBuffer(value).toString("hex");
}

function hashArray(value: string): number[] {
  return Array.from(hashBuffer(value));
}

function hexToArray(value: string): number[] {
  return Array.from(Buffer.from(value, "hex"));
}

async function writePublishRecord(record: PublishRecord): Promise<string> {
  const outputPath = resolve("data/sap/published-tools.json");
  await mkdir(dirname(outputPath), { recursive: true });
  await writeFile(outputPath, `${JSON.stringify(record, null, 2)}\n`, "utf8");
  return outputPath;
}

async function safeGetAccountInfo(
  client: { connection: { getAccountInfo(publicKey: unknown): Promise<unknown | null> } },
  publicKey: PublicKey,
  logger: ReturnType<typeof createLogger>,
): Promise<unknown | null> {
  try {
    return await client.connection.getAccountInfo(publicKey);
  } catch (error) {
    logger.warn("Unable to pre-check tool account; continuing to simulation", {
      toolPda: publicKey.toBase58(),
      error: error instanceof Error ? error.message : String(error),
    });
    return null;
  }
}

main().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : String(error);
  const stack = error instanceof Error ? error.stack : undefined;
  console.error(
    JSON.stringify({
      level: "error",
      message: "SAP tool publishing script failed",
      error: message,
      stack,
      timestamp: new Date().toISOString(),
    }),
  );
  process.exitCode = 1;
});
