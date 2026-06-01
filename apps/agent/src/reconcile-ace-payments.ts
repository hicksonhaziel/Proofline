import { readFile, writeFile } from "node:fs/promises";
import { createPublicClient, http, parseAbiItem, type Address, type Hash } from "viem";
import { base } from "viem/chains";
import type { ExecutionProofPacket, PaymentReceipt } from "../../../packages/core/src/index.js";

interface Args {
  proofPath: string;
  apply: boolean;
  lookbackBlocks: bigint;
  windowMinutes: number;
}

interface TransferLog {
  transactionHash: Hash;
  blockNumber: bigint;
  value: string;
  timestamp: string;
}

const BASE_USDC = "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913";
const TRANSFER_EVENT = parseAbiItem("event Transfer(address indexed from, address indexed to, uint256 value)");

async function main(): Promise<void> {
  const args = parseArgs(process.argv);
  const packet = JSON.parse(await readFile(args.proofPath, "utf8")) as ExecutionProofPacket;
  const acePayments = packet.payments.filter((payment) => payment.provider === "ace_data_cloud");
  const payer = firstPayer(acePayments);
  const recipient = firstRecipient(acePayments);

  if (!payer || !recipient) {
    throw new Error("Proof packet does not contain Ace payer/recipient data to reconcile.");
  }

  const client = createPublicClient({
    chain: base,
    transport: http(process.env.BASE_RPC_URL ?? "https://mainnet.base.org"),
  });
  const latest = await client.getBlockNumber();
  const fromBlock = latest > args.lookbackBlocks ? latest - args.lookbackBlocks : 0n;
  const logs = await getTransferLogs(client, payer, recipient, fromBlock, latest);
  const usedTxs = new Set<string>();
  const matches = acePayments.map((payment) => {
    const atomicAmount = receiptField(payment, "atomicAmount");
    const candidates = logs.filter(
      (log) => log.value === atomicAmount && !usedTxs.has(log.transactionHash) && isWithinPaymentWindow(log.timestamp, payment.createdAt, args.windowMinutes),
    );
    const match = candidates.at(-1);
    if (match) {
      usedTxs.add(match.transactionHash);
    }
    return {
      paymentId: payment.paymentId,
      service: payment.service,
      amount: payment.amount,
      atomicAmount,
      currentTransactionHash: payment.transactionHash ?? null,
      matchedTransactionHash: match?.transactionHash ?? null,
      matchedBlock: match ? String(match.blockNumber) : null,
      matchedAt: match?.timestamp ?? null,
      status: match ? "matched" : "unmatched",
    };
  });

  if (args.apply) {
    for (const match of matches) {
      if (!match.matchedTransactionHash) continue;
      const payment = packet.payments.find((item) => item.paymentId === match.paymentId);
      if (payment && !payment.transactionHash) {
        payment.transactionHash = match.matchedTransactionHash;
      }
    }
    await writeFile(args.proofPath, `${JSON.stringify(packet, null, 2)}\n`, "utf8");
  }

  console.log(
    JSON.stringify(
      {
        proofPath: args.proofPath,
        payer,
        recipient,
        baseUsdc: BASE_USDC,
        searchedBlocks: {
          fromBlock: String(fromBlock),
          toBlock: String(latest),
        },
        apply: args.apply,
        matches,
        note:
          "Only unique Base USDC Transfer logs with matching payer, recipient, and atomic amount are attached. Unmatched settled Ace responses are left without tx hash.",
      },
      null,
      2,
    ),
  );
}

function parseArgs(argv: string[]): Args {
  const proofArg = valueAfter(argv, "--proof") ?? "public/proofs/latest.json";
  const proofPath = proofArg === "latest" ? "public/proofs/latest.json" : proofArg;
  return {
    proofPath,
    apply: argv.includes("--apply"),
    lookbackBlocks: BigInt(Number(valueAfter(argv, "--lookback-blocks") ?? "60000")),
    windowMinutes: Number(valueAfter(argv, "--window-minutes") ?? "30"),
  };
}

function valueAfter(argv: string[], name: string): string | undefined {
  const index = argv.indexOf(name);
  if (index === -1) return undefined;
  return argv[index + 1];
}

async function getTransferLogs(
  client: any,
  payer: Address,
  recipient: Address,
  fromBlock: bigint,
  toBlock: bigint,
): Promise<TransferLog[]> {
  const logs: TransferLog[] = [];
  const chunkSize = 9000n;

  for (let start = fromBlock; start <= toBlock; start += chunkSize + 1n) {
    const end = start + chunkSize > toBlock ? toBlock : start + chunkSize;
    const chunk = await client.getLogs({
      address: BASE_USDC,
      event: TRANSFER_EVENT,
      args: {
        from: payer,
        to: recipient,
      },
      fromBlock: start,
      toBlock: end,
    });

    for (const log of chunk) {
      const block = await client.getBlock({ blockNumber: log.blockNumber });
      logs.push({
        transactionHash: log.transactionHash,
        blockNumber: log.blockNumber,
        value: log.args.value?.toString() ?? "0",
        timestamp: new Date(Number(block.timestamp) * 1000).toISOString(),
      });
    }
  }

  return logs.sort((a, b) => Number(a.blockNumber - b.blockNumber));
}

function firstPayer(payments: PaymentReceipt[]): Address | null {
  for (const payment of payments) {
    const payer = receiptField(payment, "payer");
    if (isAddress(payer)) return payer;
  }
  return null;
}

function firstRecipient(payments: PaymentReceipt[]): Address | null {
  for (const payment of payments) {
    if (isAddress(payment.recipient)) return payment.recipient;
  }
  return null;
}

function receiptField(payment: PaymentReceipt, key: string): string {
  if (!payment.receipt) return "";
  try {
    const parsed = JSON.parse(payment.receipt) as unknown;
    if (isRecord(parsed) && typeof parsed[key] === "string") {
      return parsed[key];
    }
  } catch {
    return "";
  }
  return "";
}

function isWithinPaymentWindow(logTimestamp: string, paymentTimestamp: string, windowMinutes: number): boolean {
  const logTime = new Date(logTimestamp).getTime();
  const paymentTime = new Date(paymentTimestamp).getTime();
  if (!Number.isFinite(logTime) || !Number.isFinite(paymentTime)) return false;
  const windowMs = windowMinutes * 60 * 1000;
  return Math.abs(paymentTime - logTime) <= windowMs;
}

function isAddress(value: unknown): value is Address {
  return typeof value === "string" && /^0x[0-9a-fA-F]{40}$/.test(value);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

main().catch((error: unknown) => {
  console.error(
    JSON.stringify({
      level: "error",
      message: "Ace payment reconciliation failed",
      error: error instanceof Error ? error.message : String(error),
      timestamp: new Date().toISOString(),
    }),
  );
  process.exitCode = 1;
});
