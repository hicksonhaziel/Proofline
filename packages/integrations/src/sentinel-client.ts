import type { SentinelCheck } from "../../core/src/index.js";

export interface SentinelClientOptions {
  baseUrl?: string;
  timeoutMs?: number;
  retries?: number;
  retryDelayMs?: number;
  defaultToolName?: string;
}

export interface SentinelTargetInput {
  agentId: string;
  name: string;
  endpoint: string | null;
  agentUri: string | null;
  pricePerCall: string | null;
  pricePerCallDisplay: string | null;
  token: string;
  route: string;
}

export interface SentinelCheckRequest {
  sentinelAgentId: string;
  wallet: string;
  maxSpendUsdc: number;
  target: SentinelTargetInput;
  toolName?: string;
}

export interface SentinelGate {
  proceed: boolean;
  reasons: string[];
  warnings: string[];
}

export interface SentinelCheckResult {
  sentinelCheck: SentinelCheck;
  gate: SentinelGate;
}

interface HttpResult {
  url: string;
  method: "GET" | "POST" | "HEAD";
  status: number | null;
  ok: boolean;
  headers: Record<string, string>;
  body: unknown;
  latencyMs: number;
  error?: string;
  attempts: number;
}

const DEFAULT_BASE_URL = "https://agent.sentinel.oobeprotocol.ai";
const DEFAULT_TIMEOUT_MS = 15000;
const DEFAULT_RETRIES = 2;
const DEFAULT_RETRY_DELAY_MS = 300;
const DEFAULT_TOOL = "spl-token_getBalance";

export class SentinelClient {
  private readonly baseUrl: string;
  private readonly timeoutMs: number;
  private readonly retries: number;
  private readonly retryDelayMs: number;
  private readonly defaultToolName: string;

  constructor(options: SentinelClientOptions = {}) {
    this.baseUrl = options.baseUrl ?? DEFAULT_BASE_URL;
    this.timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.retries = options.retries ?? DEFAULT_RETRIES;
    this.retryDelayMs = options.retryDelayMs ?? DEFAULT_RETRY_DELAY_MS;
    this.defaultToolName = options.defaultToolName ?? DEFAULT_TOOL;
  }

  async checkTarget(request: SentinelCheckRequest): Promise<SentinelCheckResult> {
    const checkedAt = new Date().toISOString();
    const toolName = request.toolName ?? this.defaultToolName;

    const health = await this.requestWithRetry("GET", `${this.baseUrl}/health`);
    const profile = await this.requestWithRetry("GET", `${this.baseUrl}/agent`);
    const tools = await this.requestWithRetry("GET", `${this.baseUrl}/tools`);

    const toolBody = { wallet: request.wallet };
    const unpaidToolCall = await this.requestWithRetry("POST", `${this.baseUrl}/tools/${toolName}`, toolBody);
    const depositorToolCall = await this.requestWithRetry(
      "POST",
      `${this.baseUrl}/tools/${toolName}`,
      toolBody,
      { "x-sap-depositor": request.wallet },
    );

    const endpointHead = request.target.endpoint
      ? await this.requestWithRetry("HEAD", request.target.endpoint)
      : null;
    const endpointGet = shouldFollowWithGet(endpointHead)
      ? await this.requestWithRetry("GET", request.target.endpoint as string)
      : null;
    const agentUriGet = request.target.agentUri
      ? await this.requestWithRetry("GET", request.target.agentUri)
      : null;

    const paymentRecord = firstRecord(depositorToolCall.body, unpaidToolCall.body);
    const minEscrowDepositLamports = numberField(paymentRecord, "minEscrowDeposit");
    const pricePerCallLamports = numberField(paymentRecord, "pricePerCall");
    const paymentRequired = unpaidToolCall.status === 402 || depositorToolCall.status === 402;
    const realToolReached = isSentinelToolReachable(unpaidToolCall, depositorToolCall);
    const serviceReachable = health.ok || profile.ok || tools.ok;
    const sentinelMalformed = !isRecord(health.body) && !isRecord(profile.body) && !isRecord(tools.body);

    const endpointObservations = [endpointHead, endpointGet, agentUriGet].filter((value): value is HttpResult => value !== null);
    const endpointReachable = endpointObservations.some(
      (item) => item.url === request.target.endpoint && isReachableStatus(item.status),
    );

    const metadataReachable = endpointObservations.some((item) => isReachableStatus(item.status));
    const metadataComplete = Boolean(request.target.endpoint && request.target.pricePerCallDisplay);
    const spendWithinBudget = isSpendWithinBudget(request.target, request.maxSpendUsdc);

    const gate: SentinelGate = {
      proceed: false,
      reasons: [],
      warnings: [],
    };

    if (!serviceReachable) {
      gate.reasons.push("sentinel service unavailable");
    }

    if (!realToolReached) {
      gate.reasons.push("sentinel tool path did not return a valid payment-aware response");
    }

    if (sentinelMalformed) {
      gate.reasons.push("sentinel response payload malformed");
    }

    if (!metadataComplete) {
      gate.reasons.push("target metadata incomplete (missing endpoint or pricing)");
    }

    if (!endpointReachable) {
      gate.reasons.push("target endpoint unreachable during preflight");
      if (metadataReachable) {
        gate.warnings.push("metadata endpoint responded but execution endpoint did not");
      }
    }

    if (!spendWithinBudget) {
      gate.reasons.push(`target price exceeds max spend ${request.maxSpendUsdc} USDC`);
    }

    if (paymentRequired && !depositorToolCall.ok) {
      gate.warnings.push("sentinel confirms payment is required before tool execution");
    }

    gate.proceed = gate.reasons.length === 0;

    const sentinelCheck: SentinelCheck = {
      status: gate.proceed ? "healthy" : serviceReachable || metadataReachable ? "warning" : "failed",
      sentinelAgentId: request.sentinelAgentId,
      checkedAt,
      raw: {
        mode: "synapse_sentinel_preflight",
        target: request.target,
        selectedTool: toolName,
        calls: {
          health: toRawHttpResult(health),
          profile: toRawHttpResult(profile),
          tools: toRawHttpResult(tools),
          unpaidToolCall: toRawHttpResult(unpaidToolCall),
          depositorToolCall: toRawHttpResult(depositorToolCall),
          endpointHead: endpointHead ? toRawHttpResult(endpointHead) : null,
          endpointGet: endpointGet ? toRawHttpResult(endpointGet) : null,
          agentUriGet: agentUriGet ? toRawHttpResult(agentUriGet) : null,
        },
        signals: {
          serviceReachable,
          realToolReached,
          paymentRequired,
          metadataComplete,
          endpointReachable,
          metadataReachable,
          spendWithinBudget,
          sentinelMalformed,
          minEscrowDepositLamports,
          minEscrowDepositSol: minEscrowDepositLamports === null ? null : minEscrowDepositLamports / 1_000_000_000,
          pricePerCallLamports,
        },
        gate,
        note: "Sentinel preflight verifies Sentinel liveness/payment path plus target endpoint reachability before audit execution.",
      },
      message: gate.proceed
        ? "Sentinel preflight passed and target is eligible for audit."
        : `Sentinel preflight blocked execution: ${gate.reasons.join("; ")}`,
    };

    return {
      sentinelCheck,
      gate,
    };
  }

  private async requestWithRetry(
    method: "GET" | "POST" | "HEAD",
    url: string,
    body?: unknown,
    headers: Record<string, string> = {},
  ): Promise<HttpResult> {
    let lastResult: HttpResult | null = null;

    for (let attempt = 1; attempt <= this.retries + 1; attempt += 1) {
      const startedAt = Date.now();

      try {
        const init: RequestInit = {
          method,
          headers: {
            accept: "application/json, text/plain;q=0.9, */*;q=0.8",
            "user-agent": "Proofline/0.1 sentinel-client",
            ...(body ? { "content-type": "application/json" } : {}),
            ...headers,
          },
          signal: AbortSignal.timeout(this.timeoutMs),
        };

        if (body) {
          init.body = JSON.stringify(body);
        }

        const response = await fetch(url, init);
        const payload = await parseBody(response);
        const result: HttpResult = {
          url,
          method,
          status: response.status,
          ok: response.ok,
          headers: Object.fromEntries(response.headers.entries()),
          body: payload,
          latencyMs: Date.now() - startedAt,
          attempts: attempt,
        };

        lastResult = result;
        if (shouldRetryStatus(response.status) && attempt <= this.retries) {
          await sleep(this.retryDelayMs * attempt);
          continue;
        }

        return result;
      } catch (error) {
        const result: HttpResult = {
          url,
          method,
          status: null,
          ok: false,
          headers: {},
          body: null,
          latencyMs: Date.now() - startedAt,
          attempts: attempt,
          error: error instanceof Error ? error.message : String(error),
        };

        lastResult = result;
        if (attempt <= this.retries) {
          await sleep(this.retryDelayMs * attempt);
          continue;
        }

        return result;
      }
    }

    return (
      lastResult ?? {
        url,
        method,
        status: null,
        ok: false,
        headers: {},
        body: null,
        latencyMs: 0,
        attempts: this.retries + 1,
        error: "unknown sentinel request failure",
      }
    );
  }
}

function shouldRetryStatus(status: number): boolean {
  return status === 408 || status === 425 || status === 429 || status >= 500;
}

function shouldFollowWithGet(result: HttpResult | null): boolean {
  if (!result) return false;
  if (isReachableStatus(result.status)) return false;
  return result.status === 405 || result.status === 501 || result.status === null;
}

function isReachableStatus(status: number | null): boolean {
  if (status === null) return false;
  if (status >= 200 && status < 400) return true;
  return status === 401 || status === 402 || status === 403;
}

function isSentinelToolReachable(unpaidToolCall: HttpResult, depositorToolCall: HttpResult): boolean {
  if (unpaidToolCall.ok || depositorToolCall.ok) {
    return true;
  }

  const bodies = [unpaidToolCall.body, depositorToolCall.body];
  for (const body of bodies) {
    if (!isRecord(body)) continue;
    const error = body.error;
    if (error === "payment_required" || error === "escrow_not_funded") {
      return true;
    }
  }

  return unpaidToolCall.status === 402 || depositorToolCall.status === 402;
}

function toRawHttpResult(result: HttpResult): HttpResult {
  return {
    ...result,
    body: trimLargeBody(result.body),
  };
}

function isSpendWithinBudget(target: SentinelTargetInput, maxSpendUsdc: number): boolean {
  const display = target.pricePerCallDisplay;
  if (!display) return false;

  const [amountRaw] = display.split(" ");
  const amount = Number(amountRaw);
  if (!Number.isFinite(amount)) return false;

  if (target.token === "USDC" || target.token.startsWith("SPL:EPjFWdd5")) {
    return amount <= maxSpendUsdc;
  }

  if (target.token === "SOL") {
    return amount <= 0.00035;
  }

  return true;
}

function trimLargeBody(value: unknown): unknown {
  if (typeof value === "string") {
    return value.length > 2000 ? `${value.slice(0, 2000)}...[trimmed ${value.length - 2000} chars]` : value;
  }

  if (Array.isArray(value)) {
    return value.slice(0, 8).map(trimLargeBody);
  }

  if (!isRecord(value)) {
    return value;
  }

  if (Array.isArray(value.tools)) {
    return {
      count: typeof value.count === "number" ? value.count : value.tools.length,
      total: typeof value.total === "number" ? value.total : value.tools.length,
      tools: value.tools.slice(0, 8).map((item) => trimLargeBody(item)),
      note: value.tools.length > 8 ? `trimmed ${value.tools.length - 8} tools from Sentinel response` : undefined,
    };
  }

  const out: Record<string, unknown> = {};
  for (const [key, item] of Object.entries(value)) {
    out[key] = trimLargeBody(item);
  }
  return out;
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

function firstRecord(...values: unknown[]): Record<string, unknown> | null {
  for (const value of values) {
    if (isRecord(value)) return value;
  }
  return null;
}

function numberField(record: Record<string, unknown> | null, key: string): number | null {
  const value = record?.[key];
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}
