import type { EVMProvider, PaymentRequirement } from "@acedatacloud/x402-client";
import type { Hex } from "viem";
import { privateKeyToAccount, type PrivateKeyAccount } from "viem/accounts";

export interface AceClientOptions {
  apiKey?: string;
  baseUrl?: string;
  chatModel?: string;
  imageModel?: string;
  timeoutMs?: number;
  x402WalletKey?: string;
  x402Network?: "base";
  x402PreferScheme?: "exact" | "upto";
  x402PaymentMode?: "dry-run" | "send";
  maxSpendPerRequestUsdc?: number;
  maxTotalSpendUsdc?: number;
}

export interface AceServiceResult<T = unknown> {
  service: string;
  endpoint: string;
  ok: boolean;
  status: number | null;
  latencyMs: number;
  data?: T;
  error?: string;
  x402?: AceX402Payment;
}

export interface AceX402Payment {
  status: "quoted" | "settled" | "failed";
  network: string;
  scheme: string;
  amount: string;
  atomicAmount: string;
  asset: string;
  payTo: string;
  payer?: string;
  transactionHash?: string;
  responseHeaders?: Record<string, string>;
  paymentResponse?: unknown;
  paymentRequired?: unknown;
}

export interface AceChatMessage {
  role: "system" | "user" | "assistant";
  content: string;
}

export interface AceSearchOptions {
  query: string;
  type?: "search" | "images" | "news" | "maps" | "places" | "videos";
  number?: number;
  country?: string;
  language?: string;
}

export interface AceImageOptions {
  prompt: string;
  model?: string;
  size?: "1024x1024" | "1792x1024" | "1024x1792" | "1536x1024" | "1024x1536" | "256x256" | "512x512" | "auto";
  quality?: "auto" | "high" | "medium" | "low" | "hd" | "standard";
  responseFormat?: "url" | "b64_json";
}

export interface AceImageEditOptions extends AceImageOptions {
  image: Blob;
  fileName: string;
}

export interface AceTranslateOptions {
  input: string;
  locale: string;
  extension?: "md" | "json";
}

export interface AceOpenAiChatResponse {
  choices?: Array<{
    message?: {
      content?: string;
    };
  }>;
}

const DEFAULT_BASE_URL = "https://api.acedata.cloud";
const DEFAULT_CHAT_MODEL = "gpt-4o-mini";
const DEFAULT_IMAGE_MODEL = "gpt-image-1";

export class AceDataCloudClient {
  private readonly apiKey: string | undefined;
  private readonly baseUrl: string;
  private readonly chatModel: string;
  private readonly imageModel: string;
  private readonly timeoutMs: number;
  private readonly x402Account: PrivateKeyAccount | undefined;
  private readonly x402Provider: EVMProvider | undefined;
  private readonly x402Network: "base";
  private readonly x402PreferScheme: "exact" | "upto";
  private readonly x402PaymentMode: "dry-run" | "send";
  private readonly maxSpendPerRequestUsdc: number;
  private readonly maxTotalSpendAtomic: bigint;
  private x402SpentAtomic = 0n;

  constructor(options: AceClientOptions) {
    this.apiKey = options.apiKey;
    this.baseUrl = options.baseUrl ?? DEFAULT_BASE_URL;
    this.chatModel = options.chatModel ?? DEFAULT_CHAT_MODEL;
    this.imageModel = options.imageModel ?? DEFAULT_IMAGE_MODEL;
    this.timeoutMs = options.timeoutMs ?? 60000;
    this.x402Network = options.x402Network ?? "base";
    this.x402PreferScheme = options.x402PreferScheme ?? "exact";
    this.x402PaymentMode = options.x402PaymentMode ?? "dry-run";
    this.maxSpendPerRequestUsdc = options.maxSpendPerRequestUsdc ?? 0.25;
    this.maxTotalSpendAtomic = usdcToAtomic(options.maxTotalSpendUsdc ?? options.maxSpendPerRequestUsdc ?? 0.25);

    if (options.x402WalletKey) {
      this.x402Account = privateKeyToAccount(normalizeEvmPrivateKey(options.x402WalletKey));
      this.x402Provider = new PrivateKeyEip1193Provider(this.x402Account);
    }
  }

  async chatJson(messages: AceChatMessage[], schemaHint: string): Promise<AceServiceResult<AceOpenAiChatResponse>> {
    return this.postJson<AceOpenAiChatResponse>("/openai/chat/completions", "ace_openai_chat_completions", {
      model: this.chatModel,
      messages: [
        ...messages,
        {
          role: "user",
          content: schemaHint,
        },
      ],
      temperature: 0,
      max_tokens: 700,
      response_format: {
        type: "json_object",
      },
    });
  }

  async search(options: AceSearchOptions): Promise<AceServiceResult> {
    return this.postJson("/serp/google", "ace_serp_google_search", {
      page: 1,
      type: options.type ?? "search",
      query: options.query,
      number: options.number ?? 5,
      country: options.country ?? "US",
      language: options.language ?? "en",
    });
  }

  async generateImage(options: AceImageOptions): Promise<AceServiceResult> {
    const model = options.model ?? this.imageModel;
    const body: Record<string, unknown> = {
      prompt: options.prompt,
      model,
      size: options.size ?? "1024x1024",
      quality: options.quality ?? (model.startsWith("gpt-image") ? "low" : "standard"),
      n: 1,
    };

    if (!model.startsWith("gpt-image")) {
      body.response_format = options.responseFormat ?? "b64_json";
    }

    if (model.startsWith("gpt-image")) {
      body.output_format = "png";
    }

    return this.postJson("/openai/images/generations", "ace_openai_images_generations", body);
  }

  async editImage(options: AceImageEditOptions): Promise<AceServiceResult> {
    const model = options.model ?? this.imageModel;
    const body = new FormData();
    body.append("image", options.image, options.fileName);
    body.append("prompt", options.prompt);
    body.append("model", model);
    body.append("size", options.size ?? "1024x1024");
    body.append("quality", options.quality ?? (model.startsWith("gpt-image") ? "low" : "standard"));
    body.append("n", "1");

    if (model.startsWith("gpt-image")) {
      body.append("output_format", "png");
    } else {
      body.append("response_format", options.responseFormat ?? "b64_json");
    }

    return this.postMultipart("/openai/images/edits", "ace_openai_images_edits", body);
  }

  async translate(options: AceTranslateOptions): Promise<AceServiceResult> {
    return this.postJson("/localization/translate", "ace_localization_translate", {
      input: options.input,
      locale: options.locale,
      extension: options.extension ?? "md",
    });
  }

  private async postJson<T = unknown>(path: string, service: string, body: unknown): Promise<AceServiceResult<T>> {
    const endpoint = `${this.baseUrl}${path}`;
    const startedAt = Date.now();
    const headers = this.buildHeaders("application/json");
    const bodyText = JSON.stringify(body);

    try {
      const response = await fetch(endpoint, {
        method: "POST",
        headers,
        body: bodyText,
        signal: AbortSignal.timeout(this.timeoutMs),
      });
      let latencyMs = Date.now() - startedAt;
      let payload = (await readJsonOrText(response)) as T;
      let finalResponse = response;
      let x402 = await this.maybePayAndRetry<T>(endpoint, headers, bodyText, response, payload);

      if (x402?.response) {
        finalResponse = x402.response;
        payload = x402.payload;
        latencyMs = Date.now() - startedAt;
      }

      if (!finalResponse.ok) {
        return {
          service,
          endpoint,
          ok: false,
          status: finalResponse.status,
          latencyMs,
          data: payload,
          error: describeAceError(payload, finalResponse.status),
          ...(x402?.payment ? { x402: x402.payment } : {}),
        };
      }

      return {
        service,
        endpoint,
        ok: true,
        status: finalResponse.status,
        latencyMs,
        data: payload,
        ...(x402?.payment ? { x402: x402.payment } : {}),
      };
    } catch (error) {
      return {
        service,
        endpoint,
        ok: false,
        status: null,
        latencyMs: Date.now() - startedAt,
        error: error instanceof Error ? error.message : String(error),
      };
    }
  }

  private async postMultipart<T = unknown>(path: string, service: string, body: FormData): Promise<AceServiceResult<T>> {
    const endpoint = `${this.baseUrl}${path}`;
    const startedAt = Date.now();
    const headers = this.buildHeaders();

    try {
      const response = await fetch(endpoint, {
        method: "POST",
        headers,
        body,
        signal: AbortSignal.timeout(this.timeoutMs),
      });
      let latencyMs = Date.now() - startedAt;
      let payload = (await readJsonOrText(response)) as T;
      let finalResponse = response;
      let x402 = await this.maybePayAndRetry<T>(endpoint, headers, body, response, payload);

      if (x402?.response) {
        finalResponse = x402.response;
        payload = x402.payload;
        latencyMs = Date.now() - startedAt;
      }

      if (!finalResponse.ok) {
        return {
          service,
          endpoint,
          ok: false,
          status: finalResponse.status,
          latencyMs,
          data: payload,
          error: describeAceError(payload, finalResponse.status),
          ...(x402?.payment ? { x402: x402.payment } : {}),
        };
      }

      return {
        service,
        endpoint,
        ok: true,
        status: finalResponse.status,
        latencyMs,
        data: payload,
        ...(x402?.payment ? { x402: x402.payment } : {}),
      };
    } catch (error) {
      return {
        service,
        endpoint,
        ok: false,
        status: null,
        latencyMs: Date.now() - startedAt,
        error: error instanceof Error ? error.message : String(error),
      };
    }
  }

  private buildHeaders(contentType?: string): Record<string, string> {
    const headers: Record<string, string> = {
      accept: "application/json",
    };

    if (contentType) {
      headers["content-type"] = contentType;
    }

    if (this.apiKey) {
      headers.authorization = `Bearer ${this.apiKey}`;
    }

    return headers;
  }

  private async maybePayAndRetry<T>(
    endpoint: string,
    headers: Record<string, string>,
    body: string | FormData,
    response: Response,
    payload: T,
  ): Promise<{ response?: Response; payload: T; payment?: AceX402Payment } | undefined> {
    if (response.status !== 402 || !isPaymentRequiredResponse(payload)) {
      return undefined;
    }

    const requirement = selectPaymentRequirement(payload.accepts, this.x402Network, this.x402PreferScheme);
    if (!requirement) {
      return {
        payload,
        payment: {
          status: "failed",
          network: this.x402Network,
          scheme: this.x402PreferScheme,
          amount: "0",
          atomicAmount: "0",
          asset: "",
          payTo: "",
          paymentRequired: payload,
        },
      };
    }

    const quotedPayment = paymentFromRequirement(requirement, "quoted", payload);
    const budget = validateX402Budget(requirement, this.maxSpendPerRequestUsdc, this.maxTotalSpendAtomic, this.x402SpentAtomic);
    if (!budget.ok) {
      return {
        payload,
        payment: {
          ...quotedPayment,
          status: "failed",
          paymentRequired: {
            error: budget.reason,
            response: payload,
          },
        },
      };
    }

    if (!this.x402Provider || !this.x402Account || this.x402PaymentMode !== "send") {
      return {
        payload,
        payment: quotedPayment,
      };
    }

    // The payment header signs the server's exact 402 requirement; the request
    // body is retried unchanged so pricing and settlement stay bound together.
    const signer = await loadAceX402Signer();
    const envelope =
      requirement.scheme === "upto"
        ? await signer.signEVMUptoPayment(requirement, this.x402Provider, this.x402Account.address)
        : await signer.signEVMPayment(requirement, this.x402Provider, this.x402Account.address);
    const paymentHeader = encodePaymentHeader(envelope);
    const paidResponse = await fetch(endpoint, {
      method: "POST",
      headers: {
        ...headers,
        "X-Payment": paymentHeader,
        "Access-Control-Expose-Headers": "X-Payment-Response",
      },
      body,
      signal: AbortSignal.timeout(this.timeoutMs),
    });
    const paidPayload = (await readJsonOrText(paidResponse)) as T;
    const paymentResponse = parsePaymentResponseHeader(paidResponse);
    const transactionHash = inferTransactionHash(paymentResponse, paidResponse);
    const responseHeaders = extractPaymentHeaders(paidResponse);

    if (paidResponse.ok) {
      this.x402SpentAtomic += BigInt(requirement.maxAmountRequired);
    }

    return {
      response: paidResponse,
      payload: paidPayload,
      payment: {
        ...quotedPayment,
        status: paidResponse.ok ? "settled" : "failed",
        ...(this.x402Account ? { payer: this.x402Account.address } : {}),
        ...(transactionHash ? { transactionHash } : {}),
        ...(Object.keys(responseHeaders).length > 0 ? { responseHeaders } : {}),
        ...(paymentResponse ? { paymentResponse } : {}),
      },
    };
  }
}

type AceX402SignerModule = {
  signEVMPayment: (requirements: PaymentRequirement, provider: EVMProvider, address: string) => Promise<unknown>;
  signEVMUptoPayment: (requirements: PaymentRequirement, provider: EVMProvider, address: string) => Promise<unknown>;
};

let aceX402SignerModulePromise: Promise<AceX402SignerModule> | undefined;

function loadAceX402Signer(): Promise<AceX402SignerModule> {
  const dynamicImport = new Function("specifier", "return import(specifier)") as (
    specifier: string,
  ) => Promise<AceX402SignerModule>;
  aceX402SignerModulePromise ??= dynamicImport("@acedatacloud/x402-client");
  return aceX402SignerModulePromise;
}

export function extractAceChatContent(raw: unknown): string {
  if (!isRecord(raw)) return "";
  const choices = raw.choices;
  if (!Array.isArray(choices)) return "";
  const firstChoice = choices[0];
  if (!isRecord(firstChoice)) return "";
  const message = firstChoice.message;
  if (!isRecord(message)) return "";
  return typeof message.content === "string" ? message.content : "";
}

async function readJsonOrText(response: Response): Promise<unknown> {
  const text = await response.text();
  if (text.length === 0) return {};

  try {
    return JSON.parse(text) as unknown;
  } catch {
    return text;
  }
}

function describeAceError(payload: unknown, status: number): string {
  if (isRecord(payload)) {
    const error = payload.error;
    if (isRecord(error) && typeof error.message === "string") {
      return error.message;
    }
    if (typeof payload.message === "string") {
      return payload.message;
    }
  }

  if (typeof payload === "string" && payload.length > 0) {
    return payload.slice(0, 300);
  }

  return `Ace service returned HTTP ${status}`;
}

class PrivateKeyEip1193Provider implements EVMProvider {
  constructor(private readonly account: PrivateKeyAccount) {}

  async request(args: { method: string; params?: unknown[] }): Promise<unknown> {
    if (args.method !== "eth_signTypedData_v4") {
      throw new Error(`Unsupported EVM provider method for Ace x402 signing: ${args.method}`);
    }

    const [address, typedDataJson] = args.params ?? [];
    if (typeof address !== "string" || address.toLowerCase() !== this.account.address.toLowerCase()) {
      throw new Error("Ace x402 signing address does not match configured wallet.");
    }
    if (typeof typedDataJson !== "string") {
      throw new Error("Ace x402 typed-data payload must be a JSON string.");
    }

    const typedData = JSON.parse(typedDataJson) as {
      domain: Record<string, unknown>;
      types: Record<string, Array<{ name: string; type: string }>>;
      primaryType: string;
      message: Record<string, unknown>;
    };

    return this.account.signTypedData({
      domain: typedData.domain,
      types: typedData.types,
      primaryType: typedData.primaryType,
      message: typedData.message,
    });
  }
}

function normalizeEvmPrivateKey(value: string): Hex {
  const normalized = value.startsWith("0x") ? value : `0x${value}`;
  if (!/^0x[0-9a-fA-F]{64}$/.test(normalized)) {
    throw new Error("ACE_X402_WALLET_KEY must be a 32-byte EVM private key hex string.");
  }
  return normalized as Hex;
}

function isPaymentRequiredResponse(value: unknown): value is { accepts: PaymentRequirement[] } {
  return isRecord(value) && Array.isArray(value.accepts);
}

function selectPaymentRequirement(
  accepts: PaymentRequirement[],
  network: string,
  preferScheme: "exact" | "upto",
): PaymentRequirement | undefined {
  const matches = accepts.filter((item) => item.network === network);
  if (matches.length === 0) return undefined;
  return matches.find((item) => item.scheme === preferScheme) ?? matches[0];
}

function paymentFromRequirement(
  requirement: PaymentRequirement,
  status: AceX402Payment["status"],
  paymentRequired: unknown,
): AceX402Payment {
  return {
    status,
    network: requirement.network,
    scheme: requirement.scheme,
    amount: atomicUsdcToAmount(requirement.maxAmountRequired),
    atomicAmount: requirement.maxAmountRequired,
    asset: requirement.asset,
    payTo: requirement.payTo,
    paymentRequired,
  };
}

function validateX402Budget(
  requirement: PaymentRequirement,
  maxSpendPerRequestUsdc: number,
  maxTotalSpendAtomic: bigint,
  alreadySpentAtomic: bigint,
): { ok: true } | { ok: false; reason: string } {
  const atomicAmount = BigInt(requirement.maxAmountRequired);
  const maxRequestAtomicAmount = usdcToAtomic(maxSpendPerRequestUsdc);
  if (atomicAmount > maxRequestAtomicAmount) {
    return {
      ok: false,
      reason: `Ace x402 quote ${atomicUsdcToAmount(requirement.maxAmountRequired)} USDC exceeds per-request cap ${maxSpendPerRequestUsdc} USDC.`,
    };
  }

  if (alreadySpentAtomic + atomicAmount > maxTotalSpendAtomic) {
    return {
      ok: false,
      reason: `Ace x402 cumulative quote ${atomicUsdcToAmount((alreadySpentAtomic + atomicAmount).toString())} USDC exceeds audit cap ${atomicUsdcToAmount(maxTotalSpendAtomic.toString())} USDC.`,
    };
  }

  return { ok: true };
}

function usdcToAtomic(value: number): bigint {
  return BigInt(Math.floor(value * 1_000_000));
}

function atomicUsdcToAmount(value: string): string {
  const atomic = Number(value);
  if (!Number.isFinite(atomic)) return "0";
  return String(atomic / 1_000_000);
}

function encodePaymentHeader(envelope: unknown): string {
  return Buffer.from(JSON.stringify(envelope), "utf8").toString("base64");
}

function parsePaymentResponseHeader(response: Response): unknown {
  const raw =
    response.headers.get("x-payment-response") ??
    response.headers.get("x402-tx") ??
    response.headers.get("x402_tx");
  if (!raw) return undefined;

  try {
    return JSON.parse(Buffer.from(raw, "base64").toString("utf8")) as unknown;
  } catch {
    try {
      return JSON.parse(raw) as unknown;
    } catch {
      return raw;
    }
  }
}

function extractPaymentHeaders(response: Response): Record<string, string> {
  const interesting = new Set([
    "x-payment-response",
    "x402-tx",
    "x402_tx",
    "x-request-id",
    "x-trace-id",
    "traceparent",
  ]);
  const headers: Record<string, string> = {};

  for (const [key, value] of response.headers.entries()) {
    const lower = key.toLowerCase();
    if (interesting.has(lower) || lower.includes("payment") || lower.includes("x402")) {
      headers[key] = value;
    }
  }

  return headers;
}

function inferTransactionHash(paymentResponse: unknown, response: Response): string | undefined {
  return (
    findStringValue(paymentResponse, ["transaction", "transactionHash", "txHash", "hash", "tx"]) ??
    response.headers.get("x402-tx") ??
    response.headers.get("x402_tx") ??
    undefined
  );
}

function findStringValue(value: unknown, keys: string[]): string | undefined {
  if (!isRecord(value)) return undefined;

  for (const key of keys) {
    const item = value[key];
    if (typeof item === "string" && item.length > 0) return item;
  }

  for (const item of Object.values(value)) {
    if (Array.isArray(item)) {
      for (const child of item) {
        const found = findStringValue(child, keys);
        if (found) return found;
      }
    } else {
      const found = findStringValue(item, keys);
      if (found) return found;
    }
  }

  return undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
