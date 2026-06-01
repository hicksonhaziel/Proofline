import anchor from "@coral-xyz/anchor";
import { PublicKey } from "@solana/web3.js";
import { randomUUID } from "node:crypto";
import { appendFile, mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import type { PaymentMethod, PaymentReceipt } from "../../../packages/core/src/index.js";
import { loadSapSdk } from "../../../packages/integrations/src/index.js";
import type { ProoflineConfig } from "./config.js";
import { loadKeypairFromFile } from "./keypair.js";
import type { Logger } from "./logger.js";

const { BN } = anchor;

export interface PaymentTarget {
  name: string;
  agentId: string;
  wallet: string | null;
  endpoint: string | null;
  route: "x402" | "sap_escrow" | "instant" | "batched" | "unknown";
  token: string;
  pricePerCall: string | null;
  pricePerCallDisplay: string | null;
}

export interface PaymentContext {
  auditJobId: string;
  allowPaid: boolean;
  sentinelProceed: boolean;
  target: PaymentTarget;
}

export interface AceX402Context {
  auditJobId: string;
  allowPaid: boolean;
  service: string;
}

interface PaymentProvider {
  readonly name: string;
  supports(target: PaymentTarget): boolean;
  pay(context: ProviderContext): Promise<PaymentReceipt>;
  verifySettlement?(receipt: PaymentReceipt, context: ProviderContext): Promise<PaymentReceipt>;
}

interface ProviderContext {
  config: ProoflineConfig;
  target: PaymentTarget;
  auditJobId: string;
  logger: Logger;
  mode: "dry-run" | "send";
  confirmSpend: boolean;
  maxCalls: number;
  escrowNonce: number;
}

interface RouterOptions {
  mode?: "dry-run" | "send";
  retryAttempts?: number;
  retryDelayMs?: number;
  maxCalls?: number;
  escrowNonce?: number;
  confirmSpend?: boolean;
}

export class PaymentRouter {
  private readonly providers: PaymentProvider[];
  private readonly mode: "dry-run" | "send";
  private readonly retryAttempts: number;
  private readonly retryDelayMs: number;
  private readonly maxCalls: number;
  private readonly escrowNonce: number;
  private readonly confirmSpend: boolean;

  constructor(
    private readonly config: ProoflineConfig,
    private readonly logger: Logger,
    options: RouterOptions = {},
  ) {
    this.mode = options.mode ?? envMode("PAYMENT_MODE", "dry-run");
    this.retryAttempts = options.retryAttempts ?? envNumber("PAYMENT_RETRY_ATTEMPTS", 2);
    this.retryDelayMs = options.retryDelayMs ?? envNumber("PAYMENT_RETRY_DELAY_MS", 700);
    this.maxCalls = options.maxCalls ?? envNumber("PAYMENT_MAX_CALLS", 1);
    this.escrowNonce = options.escrowNonce ?? envNumber("PAYMENT_ESCROW_NONCE", 0);
    this.confirmSpend = options.confirmSpend ?? envBoolean("PAYMENT_CONFIRM_SPEND", false);

    this.providers = [
      new SapEscrowPaymentProvider(),
      new GenericX402PaymentProvider(),
    ];
  }

  async execute(context: PaymentContext): Promise<PaymentReceipt> {
    const startedAt = new Date().toISOString();
    const amountValue = parseAmount(context.target.pricePerCallDisplay);
    const method = toPaymentMethod(context.target.route);

    const baseReceipt = {
      paymentId: `pay_${cryptoRandomId()}`,
      auditJobId: context.auditJobId,
      provider: "unknown" as const,
      method,
      amount: amountValue === null ? "0" : String(amountValue),
      currency: context.target.token === "unknown" ? "unknown" : context.target.token,
      service: context.target.name,
      createdAt: startedAt,
      ...(context.target.wallet ? { recipient: context.target.wallet } : {}),
    };

    if (!context.sentinelProceed) {
      return this.persist({
        ...baseReceipt,
        status: "skipped",
        receipt: "Sentinel preflight blocked payment flow.",
      });
    }

    if (!context.allowPaid) {
      return this.persist({
        ...baseReceipt,
        status: "skipped",
        receipt: "Paid execution disabled; router did not attempt payment.",
      });
    }

    if (isFreeTarget(context.target)) {
      return this.persist({
        ...baseReceipt,
        amount: "0",
        status: "skipped",
        receipt: "Free tier; no payment required.",
      });
    }

    const budgetCheck = validateBudget(context.target, this.config.limits.maxSpendPerAuditUsdc);
    if (!budgetCheck.ok) {
      return this.persist({
        ...baseReceipt,
        status: "failed",
        receipt: budgetCheck.reason,
      });
    }

    const provider = this.providers.find((item) => item.supports(context.target));
    if (!provider) {
      return this.persist({
        ...baseReceipt,
        status: "failed",
        receipt: `No payment provider supports target route=${context.target.route}, token=${context.target.token}`,
      });
    }

    const providerContext: ProviderContext = {
      config: this.config,
      target: context.target,
      auditJobId: context.auditJobId,
      logger: this.logger,
      mode: this.mode,
      confirmSpend: this.confirmSpend,
      maxCalls: this.maxCalls,
      escrowNonce: this.escrowNonce,
    };

    let receipt = await withRetry(
      () => provider.pay(providerContext),
      this.retryAttempts,
      this.retryDelayMs,
      (error, attempt) => {
        this.logger.warn("Payment provider attempt failed", {
          provider: provider.name,
          attempt,
          error: error instanceof Error ? error.message : String(error),
        });
      },
    );

    if (provider.verifySettlement) {
      receipt = await provider.verifySettlement(receipt, providerContext);
    }

    return this.persist(receipt);
  }

  async executeAceX402(context: AceX402Context): Promise<PaymentReceipt> {
    const providerContext: ProviderContext = {
      config: this.config,
      target: {
        name: context.service,
        agentId: "ace_data_cloud",
        wallet: null,
        endpoint: "https://platform.acedata.cloud",
        route: "x402",
        token: "USDC",
        pricePerCall: null,
        pricePerCallDisplay: null,
      },
      auditJobId: context.auditJobId,
      logger: this.logger,
      mode: this.mode,
      confirmSpend: this.confirmSpend,
      maxCalls: this.maxCalls,
      escrowNonce: this.escrowNonce,
    };

    return this.persist(
      baseProviderReceipt(
        providerContext,
        "ace_data_cloud",
        "skipped",
        "Ace x402 is paid per Ace API request by AceDataCloudClient; no order payment is created.",
        { amount: "0" },
      ),
    );
  }

  private async persist(receipt: PaymentReceipt): Promise<PaymentReceipt> {
    const ledgerPath = resolve("data/payments/receipts.jsonl");
    const perAuditPath = resolve("data/payments/by-audit", `${receipt.auditJobId}.json`);
    await mkdir(dirname(ledgerPath), { recursive: true });
    await mkdir(dirname(perAuditPath), { recursive: true });
    await appendFile(ledgerPath, `${JSON.stringify(receipt)}\n`, "utf8");
    const auditReceipts = await readAuditReceipts(perAuditPath);
    auditReceipts.push(receipt);
    await writeFile(perAuditPath, `${JSON.stringify(auditReceipts, null, 2)}\n`, "utf8");

    this.logger.info("Payment receipt persisted", {
      paymentId: receipt.paymentId,
      auditJobId: receipt.auditJobId,
      provider: receipt.provider,
      method: receipt.method,
      status: receipt.status,
      ledgerPath,
      perAuditPath,
    });

    return receipt;
  }
}

async function readAuditReceipts(path: string): Promise<PaymentReceipt[]> {
  try {
    const raw = await readFile(path, "utf8");
    const parsed = JSON.parse(raw) as unknown;
    if (Array.isArray(parsed)) return parsed.filter(isPaymentReceipt);
    if (isPaymentReceipt(parsed)) return [parsed];
    return [];
  } catch (error) {
    if (isNodeError(error) && error.code === "ENOENT") return [];
    throw error;
  }
}

function isPaymentReceipt(value: unknown): value is PaymentReceipt {
  return (
    isRecord(value) &&
    typeof value.paymentId === "string" &&
    typeof value.auditJobId === "string" &&
    typeof value.provider === "string" &&
    typeof value.method === "string" &&
    typeof value.status === "string"
  );
}

class SapEscrowPaymentProvider implements PaymentProvider {
  readonly name = "sap_escrow_provider";

  supports(target: PaymentTarget): boolean {
    const routeOk = target.route === "x402" || target.route === "sap_escrow";
    const tokenOk = target.token === "SOL";
    return routeOk && tokenOk && typeof target.pricePerCall === "string" && target.pricePerCall.length > 0;
  }

  async pay(context: ProviderContext): Promise<PaymentReceipt> {
    const sdk = loadSapSdk();
    const keypair = await loadKeypairFromFile(context.config.sapKeypairPath);
    const wallet = keypair.publicKey;
    const client = new sdk.SapClient({
      rpcUrl: context.config.synapseRpcUrl,
      commitment: "confirmed",
    });

    if (!context.config.flags.enableSapEscrow) {
      return baseProviderReceipt(context, "sap", "failed", "SAP escrow payments disabled by ENABLE_SAP_ESCROW=false.");
    }

    if (!context.target.pricePerCall) {
      return baseProviderReceipt(context, "sap", "failed", "Target has no pricePerCall for SAP escrow payment.");
    }

    const pricePerCall = new BN(context.target.pricePerCall);
    if (pricePerCall.lten(0)) {
      return baseProviderReceipt(context, "sap", "skipped", "Free tier; no escrow payment needed.", { amount: "0" });
    }

    const maxCalls = new BN(context.maxCalls);
    const initialDeposit = pricePerCall.mul(maxCalls);
    const agentPda = new PublicKey(context.target.agentId);

    const [agentStakePda] = derivePda(["sap_stake", agentPda], String(sdk.PROGRAM_ID));
    const [agentStatsPda] = derivePda(["sap_stats", agentPda], String(sdk.PROGRAM_ID));
    const [pricingMenuPda] = derivePda(["sap_pricing", agentPda], String(sdk.PROGRAM_ID));
    const [escrowPda] = derivePda(["sap_escrow_v2", agentPda, wallet, u64Le(context.escrowNonce)], String(sdk.PROGRAM_ID));

    const existingEscrow = await safeGetAccountInfo(client, escrowPda, context.logger);
    if (existingEscrow) {
      return baseProviderReceipt(
        context,
        "sap",
        context.mode === "send" ? "pending" : "pending",
        "Existing SAP escrow account found; reusing escrow for payment flow.",
        {
          amount: asAmount(context.target.pricePerCallDisplay),
        },
      );
    }

    const instruction = await client.escrow.createEscrowV2({
      signer: keypair,
      depositor: wallet,
      agent: agentPda,
      agentStake: agentStakePda,
      agentStats: agentStatsPda,
      pricingMenu: pricingMenuPda,
      escrow: escrowPda,
      escrowNonce: new BN(context.escrowNonce),
      pricePerCall,
      maxCalls,
      initialDeposit,
      expiresAt: new BN(0),
      volumeCurve: [],
      tokenMint: null,
      tokenDecimals: 9,
      settlementSecurity: 2,
      disputeWindowSlots: new BN(150),
      coSigner: null,
      arbiter: wallet,
    });

    const tx = await client.buildTransaction([instruction], wallet);
    tx.sign([keypair]);

    const simulation = await client.connection.simulateTransaction(tx);
    if (simulation.value.err) {
      return baseProviderReceipt(
        context,
        "sap",
        "failed",
        `SAP escrow simulation failed: ${JSON.stringify(simulation.value.err)}`,
      );
    }

    if (context.mode === "dry-run") {
      return baseProviderReceipt(
        context,
        "sap",
        "pending",
        "Dry-run: SAP escrow simulation passed; no transaction sent.",
      );
    }

    if (!context.confirmSpend) {
      return baseProviderReceipt(
        context,
        "sap",
        "failed",
        "Send mode blocked: PAYMENT_CONFIRM_SPEND is not true.",
      );
    }

    const signature = await client.connection.sendTransaction(tx, {
      preflightCommitment: "confirmed",
      maxRetries: 3,
    });

    return baseProviderReceipt(
      context,
      "sap",
      "pending",
      "SAP escrow transaction submitted; awaiting confirmation.",
      {
        transactionHash: signature,
      },
    );
  }

  async verifySettlement(receipt: PaymentReceipt, context: ProviderContext): Promise<PaymentReceipt> {
    if (!receipt.transactionHash) {
      return receipt;
    }

    const sdk = loadSapSdk();
    const client = new sdk.SapClient({
      rpcUrl: context.config.synapseRpcUrl,
      commitment: "confirmed",
    });

    try {
      const statuses = await client.connection.getSignatureStatuses([receipt.transactionHash]);
      const status = statuses.value[0];

      if (!status) {
        return {
          ...receipt,
          status: "pending",
          receipt: `${receipt.receipt ?? "Payment submitted."} Signature not yet visible on RPC.`,
        };
      }

      if (status.err) {
        return {
          ...receipt,
          status: "failed",
          receipt: `${receipt.receipt ?? "Payment submitted."} Settlement failed on chain: ${JSON.stringify(status.err)}`,
        };
      }

      if (status.confirmationStatus === "confirmed" || status.confirmationStatus === "finalized") {
        return {
          ...receipt,
          status: "settled",
          confirmedAt: new Date().toISOString(),
          receipt: `${receipt.receipt ?? "Payment submitted."} Settlement confirmed (${status.confirmationStatus}).`,
        };
      }

      return {
        ...receipt,
        status: "pending",
        receipt: `${receipt.receipt ?? "Payment submitted."} Awaiting confirmation (${status.confirmationStatus ?? "processed"}).`,
      };
    } catch (error) {
      return {
        ...receipt,
        status: "pending",
        receipt: `${receipt.receipt ?? "Payment submitted."} Verification error: ${error instanceof Error ? error.message : String(error)}`,
      };
    }
  }
}

class GenericX402PaymentProvider implements PaymentProvider {
  readonly name = "generic_x402_provider";

  supports(target: PaymentTarget): boolean {
    return target.route === "x402" && typeof target.endpoint === "string" && target.endpoint.startsWith("https://");
  }

  async pay(context: ProviderContext): Promise<PaymentReceipt> {
    if (!context.target.endpoint) {
      return baseProviderReceipt(context, "unknown", "failed", "x402 endpoint missing.");
    }

    const origin = safeOrigin(context.target.endpoint);
    const quoteUrl = origin ? `${origin}/payment/quote` : null;

    if (!quoteUrl) {
      return baseProviderReceipt(context, "unknown", "failed", "Could not derive payment quote URL from endpoint.");
    }

    let quoteStatus: number | null = null;
    let quoteBody: unknown = null;

    try {
      const keypair = await loadKeypairFromFile(context.config.sapKeypairPath);
      const depositor = keypair.publicKey.toBase58();
      const response = await fetch(quoteUrl, {
        method: "POST",
        headers: {
          accept: "application/json, text/plain;q=0.9, */*;q=0.8",
          "content-type": "application/json",
          "user-agent": "Proofline/0.1 payment-router",
        },
        body: JSON.stringify({
          depositor,
          service: context.target.name,
          endpoint: context.target.endpoint,
        }),
        signal: AbortSignal.timeout(15000),
      });

      quoteStatus = response.status;
      quoteBody = await parseBody(response);
    } catch (error) {
      return baseProviderReceipt(
        context,
        "unknown",
        "failed",
        `x402 quote request failed: ${error instanceof Error ? error.message : String(error)}`,
      );
    }

    if (context.mode === "dry-run") {
      return baseProviderReceipt(
        context,
        "unknown",
        "pending",
        `Dry-run x402 quote status ${quoteStatus}. Manual settlement required for this endpoint type.`,
        {
          receiptPayload: {
            quoteUrl,
            quoteStatus,
            quoteBody,
          },
        },
      );
    }

    return baseProviderReceipt(
      context,
      "unknown",
      "failed",
      "Generic x402 send mode is not implemented for this endpoint; SAP escrow provider is required.",
      {
        receiptPayload: {
          quoteUrl,
          quoteStatus,
          quoteBody,
        },
      },
    );
  }
}

function baseProviderReceipt(
  context: ProviderContext,
  provider: PaymentReceipt["provider"],
  status: PaymentReceipt["status"],
  receiptMessage: string,
  extras: {
    transactionHash?: string;
    confirmedAt?: string;
    amount?: string;
    receiptPayload?: unknown;
  } = {},
): PaymentReceipt {
  const amount = extras.amount ?? asAmount(context.target.pricePerCallDisplay);
  const receipt = extras.receiptPayload
    ? `${receiptMessage} payload=${JSON.stringify(trimPayload(extras.receiptPayload))}`
    : receiptMessage;

  return {
    paymentId: `pay_${cryptoRandomId()}`,
    auditJobId: context.auditJobId,
    provider,
    method: toPaymentMethod(context.target.route),
    amount,
    currency: context.target.token === "unknown" ? "unknown" : context.target.token,
    ...(context.target.wallet ? { recipient: context.target.wallet } : {}),
    service: context.target.name,
    status,
    receipt,
    ...(extras.transactionHash ? { transactionHash: extras.transactionHash } : {}),
    createdAt: new Date().toISOString(),
    ...(extras.confirmedAt ? { confirmedAt: extras.confirmedAt } : {}),
  };
}

function toPaymentMethod(route: PaymentTarget["route"]): PaymentMethod {
  if (route === "x402") return "x402";
  if (route === "sap_escrow") return "sap_escrow";
  return "unknown";
}

function parseAmount(display: string | null): number | null {
  if (!display) return null;
  const amount = Number(display.split(" ")[0]);
  return Number.isFinite(amount) ? amount : null;
}

function asAmount(display: string | null): string {
  const value = parseAmount(display);
  return value === null ? "0" : String(value);
}

function isFreeTarget(target: PaymentTarget): boolean {
  const amount = parseAmount(target.pricePerCallDisplay);
  if (amount === 0) return true;
  if (target.pricePerCall === "0") return true;
  return false;
}

function validateBudget(target: PaymentTarget, maxSpendUsdc: number): { ok: true } | { ok: false; reason: string } {
  const amount = parseAmount(target.pricePerCallDisplay);
  if (amount === null) {
    return { ok: false, reason: "Target price is missing or non-numeric." };
  }

  if (target.token === "USDC" || target.token.startsWith("SPL:EPjFWdd5")) {
    if (amount > maxSpendUsdc) {
      return { ok: false, reason: `Target price ${amount} USDC exceeds audit max ${maxSpendUsdc}.` };
    }
  }

  if (target.token === "SOL" && amount > 0.00035) {
    return { ok: false, reason: `Target price ${amount} SOL exceeds safety cap 0.00035 SOL.` };
  }

  return { ok: true };
}

function derivePda(seeds: Array<string | PublicKey | Uint8Array>, programId: string): [PublicKey, number] {
  const buffers = seeds.map((seed) => {
    if (typeof seed === "string") return Buffer.from(seed);
    if (seed instanceof PublicKey) return seed.toBuffer();
    return Buffer.from(seed);
  });

  return PublicKey.findProgramAddressSync(buffers, new PublicKey(programId));
}

function u64Le(value: number): Uint8Array {
  const out = new Uint8Array(8);
  const view = new DataView(out.buffer);
  view.setBigUint64(0, BigInt(value), true);
  return out;
}

async function safeGetAccountInfo(
  client: { connection: { getAccountInfo(publicKey: PublicKey): Promise<unknown | null> } },
  publicKey: PublicKey,
  logger: Logger,
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

function trimPayload(value: unknown): unknown {
  if (typeof value === "string") {
    return value.length > 500 ? `${value.slice(0, 500)}...[trimmed ${value.length - 500} chars]` : value;
  }

  if (Array.isArray(value)) {
    return value.slice(0, 8).map(trimPayload);
  }

  if (!isRecord(value)) {
    return value;
  }

  const out: Record<string, unknown> = {};
  for (const [key, item] of Object.entries(value)) {
    out[key] = trimPayload(item);
  }
  return out;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isNodeError(value: unknown): value is NodeJS.ErrnoException {
  return value instanceof Error && "code" in value;
}

async function parseBody(response: Response): Promise<unknown> {
  const text = await response.text();
  if (text.length === 0) {
    return {};
  }

  try {
    return JSON.parse(text) as unknown;
  } catch {
    return text;
  }
}

function safeOrigin(url: string): string | null {
  try {
    return new URL(url).origin;
  } catch {
    return null;
  }
}

async function withRetry<T>(
  operation: () => Promise<T>,
  retryAttempts: number,
  retryDelayMs: number,
  onError: (error: unknown, attempt: number) => void,
): Promise<T> {
  let lastError: unknown;

  for (let attempt = 1; attempt <= retryAttempts + 1; attempt += 1) {
    try {
      return await operation();
    } catch (error) {
      lastError = error;
      if (attempt > retryAttempts) {
        break;
      }

      onError(error, attempt);
      await sleep(retryDelayMs * attempt);
    }
  }

  throw lastError instanceof Error ? lastError : new Error(String(lastError));
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

function envNumber(name: string, fallback: number): number {
  const value = process.env[name];
  if (!value) return fallback;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function envBoolean(name: string, fallback: boolean): boolean {
  const value = process.env[name];
  if (!value) return fallback;
  return value.toLowerCase() === "true";
}

function envMode(name: string, fallback: "dry-run" | "send"): "dry-run" | "send" {
  const value = process.env[name]?.toLowerCase();
  if (value === "send") return "send";
  if (value === "dry-run") return "dry-run";
  return fallback;
}

function cryptoRandomId(): string {
  return randomUUID();
}
