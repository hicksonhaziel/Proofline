export interface AceClientOptions {
  apiKey: string;
  baseUrl?: string;
  chatModel?: string;
  imageModel?: string;
  timeoutMs?: number;
}

export interface AceServiceResult<T = unknown> {
  service: string;
  endpoint: string;
  ok: boolean;
  status: number | null;
  latencyMs: number;
  data?: T;
  error?: string;
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
  private readonly apiKey: string;
  private readonly baseUrl: string;
  private readonly chatModel: string;
  private readonly imageModel: string;
  private readonly timeoutMs: number;

  constructor(options: AceClientOptions) {
    this.apiKey = options.apiKey;
    this.baseUrl = options.baseUrl ?? DEFAULT_BASE_URL;
    this.chatModel = options.chatModel ?? DEFAULT_CHAT_MODEL;
    this.imageModel = options.imageModel ?? DEFAULT_IMAGE_MODEL;
    this.timeoutMs = options.timeoutMs ?? 60000;
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

    try {
      const response = await fetch(endpoint, {
        method: "POST",
        headers: {
          accept: "application/json",
          authorization: `Bearer ${this.apiKey}`,
          "content-type": "application/json",
        },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(this.timeoutMs),
      });
      const latencyMs = Date.now() - startedAt;
      const payload = (await readJsonOrText(response)) as T;

      if (!response.ok) {
        return {
          service,
          endpoint,
          ok: false,
          status: response.status,
          latencyMs,
          data: payload,
          error: describeAceError(payload, response.status),
        };
      }

      return {
        service,
        endpoint,
        ok: true,
        status: response.status,
        latencyMs,
        data: payload,
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

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
