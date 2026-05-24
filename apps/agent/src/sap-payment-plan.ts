import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import anchor from "@coral-xyz/anchor";
import { PublicKey } from "@solana/web3.js";
import { loadSapSdk } from "../../../packages/integrations/src/index.js";
import { loadConfig, safeConfigSummary } from "./config.js";
import { loadKeypairFromFile } from "./keypair.js";
import { createLogger } from "./logger.js";

interface AuditTargetPlan {
  recommendedTargets?: PlannedTarget[];
  allTargets?: PlannedTarget[];
}

interface PlannedTarget {
  name: string;
  pda: string;
  wallet: string | null;
  endpoint: string | null;
  agentUri: string | null;
  protocolIds: string[];
  pricingTier: string | null;
  route: "x402" | "sap_escrow" | "instant" | "batched" | "unknown";
  token: string;
  pricePerCall: string | null;
  pricePerCallDisplay: string | null;
  status: string;
}

interface CliArgs {
  target?: string | undefined;
  nonce: number;
  maxCalls: number;
  mode: "dry-run" | "send";
  confirmSpend: boolean;
}

interface PaymentPlanRecord {
  mode: "dry-run" | "send";
  status: "simulated" | "submitted" | "existing_escrow" | "unsupported" | "failed";
  generatedAt: string;
  wallet: string;
  walletBalanceSol: number;
  target: PlannedTarget;
  escrow: {
    escrowNonce: number;
    agentPda: string;
    agentStakePda: string;
    agentStatsPda: string;
    pricingMenuPda: string;
    escrowPda: string;
    pricePerCall: string;
    maxCalls: string;
    initialDeposit: string;
    estimatedCostPerCallIfFullyUsed?: string;
    token: string;
    tokenDecimals: number;
    settlementSecurity: "dispute_window";
    disputeWindowSlots: string;
  };
  x402Headers: Record<string, string>;
  simulation?: {
    ok: boolean;
    error: unknown;
    logs: string[];
    walletPreLamports?: number;
    walletPostLamports?: number;
    estimatedSpendLamports?: number;
    escrowPostLamports?: number;
  };
  signature?: string;
  notes: string[];
}

const PLAN_PATH = "data/sap/audit-target-plan.json";
const OUTPUT_PATH = "data/sap/payment-plan.json";
const DEFAULT_NONCE = 0;
const DEFAULT_MAX_CALLS = 1;
const { BN } = anchor;
const DEFAULT_DISPUTE_WINDOW_SLOTS = new BN(150);
const MAX_SEND_PRICE_LAMPORTS = 10_000;
const MAX_SEND_CALLS = 25;

async function main(): Promise<void> {
  const args = parseArgs(process.argv);
  const runId = `sap_payment_plan_${Date.now()}`;
  const logger = createLogger(runId);
  const config = loadConfig();

  logger.info("Starting SAP x402 payment planner", {
    args,
    config: safeConfigSummary(config),
  });

  const target = await selectTarget(args.target);
  const sdk = loadSapSdk();
  const keypair = await loadKeypairFromFile(config.sapKeypairPath);
  const wallet = keypair.publicKey;
  const client = new sdk.SapClient({
    rpcUrl: config.synapseRpcUrl,
    commitment: "confirmed",
  });
  const walletBalanceLamports = await client.connection.getBalance(wallet);

  if (target.route !== "x402" || target.token !== "SOL" || !target.pricePerCall) {
    const unsupportedRecord = buildUnsupportedRecord(target, wallet, walletBalanceLamports, args.nonce);
    const outputPath = await writeJson(OUTPUT_PATH, unsupportedRecord);
    logger.warn("Target is not supported by the Phase 4B SOL x402 planner", {
      target: target.name,
      route: target.route,
      token: target.token,
      outputPath,
    });
    return;
  }

  const pricePerCall = new BN(target.pricePerCall);
  if (pricePerCall.lten(0)) {
    const unsupportedRecord = buildUnsupportedRecord(target, wallet, walletBalanceLamports, args.nonce, [
      "Target price is zero; no escrow payment is needed for this tier.",
    ]);
    const outputPath = await writeJson(OUTPUT_PATH, unsupportedRecord);
    logger.warn("Target has a free tier; payment escrow is not needed", { target: target.name, outputPath });
    return;
  }

  const agentPda = new PublicKey(target.pda);
  const [agentStakePda] = derivePda(["sap_stake", agentPda], String(sdk.PROGRAM_ID));
  const [agentStatsPda] = derivePda(["sap_stats", agentPda], String(sdk.PROGRAM_ID));
  const [pricingMenuPda] = derivePda(["sap_pricing", agentPda], String(sdk.PROGRAM_ID));
  const [escrowPda] = derivePda(["sap_escrow_v2", agentPda, wallet, u64Le(args.nonce)], String(sdk.PROGRAM_ID));
  const existingEscrow = await safeGetAccountInfo(client, escrowPda, logger);
  const maxCalls = new BN(args.maxCalls);
  const initialDeposit = pricePerCall.mul(maxCalls);

  const record: PaymentPlanRecord = {
    mode: args.mode,
    status: args.mode === "send" ? "submitted" : "simulated",
    generatedAt: new Date().toISOString(),
    wallet: wallet.toBase58(),
    walletBalanceSol: walletBalanceLamports / 1_000_000_000,
    target,
    escrow: {
      escrowNonce: args.nonce,
      agentPda: agentPda.toBase58(),
      agentStakePda: agentStakePda.toBase58(),
      agentStatsPda: agentStatsPda.toBase58(),
      pricingMenuPda: pricingMenuPda.toBase58(),
      escrowPda: escrowPda.toBase58(),
      pricePerCall: pricePerCall.toString(),
      maxCalls: maxCalls.toString(),
      initialDeposit: initialDeposit.toString(),
      token: "SOL",
      tokenDecimals: 9,
      settlementSecurity: "dispute_window",
      disputeWindowSlots: DEFAULT_DISPUTE_WINDOW_SLOTS.toString(),
    },
    x402Headers: {
      "X-Payment-Protocol": "SAP-x402",
      "X-Payment-Escrow": escrowPda.toBase58(),
      "X-Payment-Agent": agentPda.toBase58(),
      "X-Payment-Depositor": wallet.toBase58(),
      "X-Payment-MaxCalls": maxCalls.toString(),
      "X-Payment-PricePerCall": pricePerCall.toString(),
      "X-Payment-Program": String(sdk.PROGRAM_ID),
      "X-Payment-Network": "solana:mainnet-beta",
    },
    notes: [
      "This planner supports only SOL-priced SAP x402 targets for now.",
      "Dry-run simulation does not spend SOL.",
      "Opening an escrow spends transaction fee plus rent for the escrow account, even when the per-call price is tiny.",
      "An escrow is not meant to be opened per call. Reuse the same target/depositor/nonce escrow until its funded calls are used.",
      "The agent, agent stake, pricing menu, and escrow PDAs are derived from the SAP program ID and target agent PDA.",
      "For the Phase 4B dry-run, Proofline uses its own wallet as the dispute-window arbiter.",
    ],
  };

  if (existingEscrow) {
    record.status = "existing_escrow";
    record.notes.push("Existing escrow account found. No create transaction is needed; reuse the x402 headers in this plan.");
    record.escrow.estimatedCostPerCallIfFullyUsed = "0";
    const outputPath = await writeJson(OUTPUT_PATH, record);
    logger.info("Existing SAP x402 escrow found; no transaction needed", {
      target: target.name,
      escrowPda: escrowPda.toBase58(),
      outputPath,
    });
    return;
  }

  const instruction = await client.escrow.createEscrowV2({
    signer: keypair,
    depositor: wallet,
    agent: agentPda,
    agentStake: agentStakePda,
    agentStats: agentStatsPda,
    pricingMenu: pricingMenuPda,
    escrow: escrowPda,
    escrowNonce: new BN(args.nonce),
    pricePerCall,
    maxCalls,
    initialDeposit,
    expiresAt: new BN(0),
    volumeCurve: [],
    tokenMint: null,
    tokenDecimals: 9,
    settlementSecurity: 2,
    disputeWindowSlots: DEFAULT_DISPUTE_WINDOW_SLOTS,
    coSigner: null,
    arbiter: wallet,
  });
  const tx = await client.buildTransaction([instruction], wallet);
  tx.sign([keypair]);

  const simulation = await client.connection.simulateTransaction(tx, {
    accounts: {
      encoding: "base64",
      addresses: [wallet.toBase58(), escrowPda.toBase58()],
    },
  });
  const simulatedWallet = simulation.value.accounts?.[0];
  const simulatedEscrow = simulation.value.accounts?.[1];
  const simulatedWalletLamports = simulatedWallet?.lamports;
  const simulatedEscrowLamports = simulatedEscrow?.lamports;
  record.simulation = {
    ok: !simulation.value.err,
    error: simulation.value.err,
    logs: simulation.value.logs ?? [],
    walletPreLamports: walletBalanceLamports,
    ...(typeof simulatedWalletLamports === "number" ? { walletPostLamports: simulatedWalletLamports } : {}),
    ...(typeof simulatedWalletLamports === "number" ? { estimatedSpendLamports: walletBalanceLamports - simulatedWalletLamports } : {}),
    ...(typeof simulatedEscrowLamports === "number" ? { escrowPostLamports: simulatedEscrowLamports } : {}),
  };
  if (typeof record.simulation.estimatedSpendLamports === "number") {
    record.escrow.estimatedCostPerCallIfFullyUsed = (record.simulation.estimatedSpendLamports / args.maxCalls).toString();
  }

  if (simulation.value.err) {
    record.status = "failed";
    const outputPath = await writeJson(OUTPUT_PATH, record);
    logger.error("SAP x402 escrow simulation failed", {
      target: target.name,
      simulationError: simulation.value.err,
      logs: simulation.value.logs?.slice(-10) ?? [],
      outputPath,
    });
    process.exitCode = 1;
    return;
  }

  logger.info("SAP x402 escrow simulation passed", {
    target: target.name,
    escrowPda: escrowPda.toBase58(),
    pricePerCall: pricePerCall.toString(),
    logs: simulation.value.logs?.slice(-8) ?? [],
  });

  if (args.mode === "send") {
    if (!args.confirmSpend) {
      record.status = "failed";
      record.notes.push("Send mode refused because --confirm-spend was not provided.");
      const outputPath = await writeJson(OUTPUT_PATH, record);
      logger.error("Refusing to send escrow transaction without --confirm-spend", { outputPath });
      process.exitCode = 1;
      return;
    }

    if (pricePerCall.gt(new BN(MAX_SEND_PRICE_LAMPORTS))) {
      record.status = "failed";
      record.notes.push(`Send mode refused because price ${pricePerCall.toString()} exceeds ${MAX_SEND_PRICE_LAMPORTS} lamports.`);
      const outputPath = await writeJson(OUTPUT_PATH, record);
      logger.error("Refusing to send escrow transaction above hardcoded lamport cap", {
        pricePerCall: pricePerCall.toString(),
        maxSendPriceLamports: MAX_SEND_PRICE_LAMPORTS,
        outputPath,
      });
      process.exitCode = 1;
      return;
    }

    if (args.maxCalls > MAX_SEND_CALLS) {
      record.status = "failed";
      record.notes.push(`Send mode refused because maxCalls ${args.maxCalls} exceeds ${MAX_SEND_CALLS}.`);
      const outputPath = await writeJson(OUTPUT_PATH, record);
      logger.error("Refusing to send escrow transaction above max call cap", {
        maxCalls: args.maxCalls,
        maxSendCalls: MAX_SEND_CALLS,
        outputPath,
      });
      process.exitCode = 1;
      return;
    }

    const signature = await client.connection.sendTransaction(tx, {
      preflightCommitment: "confirmed",
      maxRetries: 3,
    });
    record.signature = signature;
    logger.info("SAP x402 escrow transaction submitted", { signature });
  } else {
    logger.warn("Dry-run only; no SOL was spent. Use --send --confirm-spend only after reviewing data/sap/payment-plan.json");
  }

  const outputPath = await writeJson(OUTPUT_PATH, record);
  logger.info("Saved SAP x402 payment plan", { outputPath });
}

function parseArgs(argv: string[]): CliArgs {
  const targetIndex = argv.findIndex((arg) => arg === "--target");
  const target = targetIndex >= 0 ? argv[targetIndex + 1] : undefined;
  const nonceIndex = argv.findIndex((arg) => arg === "--nonce");
  const nonceRaw = nonceIndex >= 0 ? argv[nonceIndex + 1] : undefined;
  const nonce = nonceRaw ? Number(nonceRaw) : DEFAULT_NONCE;
  const maxCallsIndex = argv.findIndex((arg) => arg === "--max-calls");
  const maxCallsRaw = maxCallsIndex >= 0 ? argv[maxCallsIndex + 1] : undefined;
  const maxCalls = maxCallsRaw ? Number(maxCallsRaw) : DEFAULT_MAX_CALLS;

  if (!Number.isSafeInteger(nonce) || nonce < 0) {
    throw new Error("--nonce must be a non-negative safe integer");
  }

  if (!Number.isSafeInteger(maxCalls) || maxCalls < 1) {
    throw new Error("--max-calls must be a positive safe integer");
  }

  return {
    target: target && !target.startsWith("--") ? target : undefined,
    nonce,
    maxCalls,
    mode: argv.includes("--send") ? "send" : "dry-run",
    confirmSpend: argv.includes("--confirm-spend"),
  };
}

async function selectTarget(targetQuery: string | undefined): Promise<PlannedTarget> {
  const raw = await readFile(resolve(PLAN_PATH), "utf8");
  const plan = JSON.parse(raw) as AuditTargetPlan;
  const targets = [...(plan.recommendedTargets ?? []), ...(plan.allTargets ?? [])].filter(isUsableTarget);

  if (targets.length === 0) {
    throw new Error(`No usable targets found in ${PLAN_PATH}. Run npm run sap:discover first.`);
  }

  if (targetQuery) {
    const normalized = targetQuery.toLowerCase();
    const match = targets.find(
      (target) =>
        target.name.toLowerCase() === normalized ||
        target.name.toLowerCase().includes(normalized) ||
        target.pda === targetQuery,
    );

    if (!match) {
      throw new Error(`No usable target matched "${targetQuery}" in ${PLAN_PATH}`);
    }

    return match;
  }

  const paidSolTarget = targets.find((target) => target.route === "x402" && target.token === "SOL" && Number(target.pricePerCall ?? "0") > 0);
  if (paidSolTarget) return paidSolTarget;

  return targets[0]!;
}

function isUsableTarget(target: PlannedTarget): boolean {
  return (
    (target.status === "good_audit_target" || target.status === "free") &&
    typeof target.endpoint === "string" &&
    target.endpoint.length > 0 &&
    !target.endpoint.includes("/:") &&
    !target.endpoint.includes(":name")
  );
}

function buildUnsupportedRecord(
  target: PlannedTarget,
  wallet: PublicKey,
  walletBalanceLamports: number,
  nonce: number,
  notes: string[] = [],
): PaymentPlanRecord {
  const placeholder = PublicKey.default.toBase58();
  return {
    mode: "dry-run",
    status: "unsupported",
    generatedAt: new Date().toISOString(),
    wallet: wallet.toBase58(),
    walletBalanceSol: walletBalanceLamports / 1_000_000_000,
    target,
    escrow: {
      escrowNonce: nonce,
      agentPda: target.pda,
      agentStakePda: placeholder,
      agentStatsPda: placeholder,
      pricingMenuPda: placeholder,
      escrowPda: placeholder,
      pricePerCall: target.pricePerCall ?? "0",
      maxCalls: "0",
      initialDeposit: "0",
      token: target.token,
      tokenDecimals: target.token === "SOL" ? 9 : 6,
      settlementSecurity: "dispute_window",
      disputeWindowSlots: DEFAULT_DISPUTE_WINDOW_SLOTS.toString(),
    },
    x402Headers: {},
    notes: [
      "No transaction was built for this target.",
      ...notes,
    ],
  };
}

function derivePda(seeds: Array<string | PublicKey | Buffer>, programId: string): [PublicKey, number] {
  return PublicKey.findProgramAddressSync(
    seeds.map((seed) => {
      if (typeof seed === "string") return Buffer.from(seed);
      if (seed instanceof PublicKey) return seed.toBuffer();
      return seed;
    }),
    new PublicKey(programId),
  );
}

function u64Le(value: number): Buffer {
  const buffer = Buffer.alloc(8);
  buffer.writeBigUInt64LE(BigInt(value));
  return buffer;
}

async function writeJson(path: string, value: unknown): Promise<string> {
  const outputPath = resolve(path);
  await mkdir(dirname(outputPath), { recursive: true });
  await writeFile(outputPath, `${JSON.stringify(value, null, 2)}\n`, "utf8");
  return outputPath;
}

async function safeGetAccountInfo(
  client: { connection: { getAccountInfo(publicKey: PublicKey): Promise<unknown | null> } },
  publicKey: PublicKey,
  logger: ReturnType<typeof createLogger>,
): Promise<unknown | null> {
  try {
    return await client.connection.getAccountInfo(publicKey);
  } catch (error) {
    logger.warn("Account existence check failed; continuing to transaction simulation", {
      publicKey: publicKey.toBase58(),
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
      message: "SAP x402 payment planner failed",
      error: message,
      stack,
      timestamp: new Date().toISOString(),
    }),
  );
  process.exitCode = 1;
});
