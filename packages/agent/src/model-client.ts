export interface ModelToolSchema {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
}

export interface ModelToolCall {
  id: string;
  name: string;
  arguments: Record<string, unknown>;
}

export type ModelMessage =
  | { role: "system" | "user"; content: string }
  | { role: "assistant"; content: string | null; toolCalls?: ModelToolCall[] }
  | { role: "tool"; toolCallId: string; content: string };

export interface ModelResponse {
  content: string | null;
  toolCalls: ModelToolCall[];
  finishReason: string;
  usage?: { promptTokens: number; completionTokens: number; totalTokens: number };
}

export interface ModelClientLike {
  chat(messages: ModelMessage[], tools: ModelToolSchema[]): Promise<ModelResponse>;
}

export interface ModelClientConfig {
  apiKey: string;
  baseUrl?: string;
  model: string;
  maxRetries?: number;
  requestTimeoutMs?: number;
}

export class ModelHttpError extends Error {
  readonly status: number;
  readonly retryAfterMs?: number;
  constructor(status: number, message: string, retryAfterMs?: number) {
    super(message);
    this.name = "ModelHttpError";
    this.status = status;
    this.retryAfterMs = retryAfterMs;
  }
}

const maxRetryAfterMs = 60_000;

const defaultBaseUrl = "https://api.openai.com/v1";

export class ModelClient implements ModelClientLike {
  private readonly config: Required<Omit<ModelClientConfig, "apiKey">> & { apiKey: string };

  constructor(config: ModelClientConfig) {
    this.config = {
      apiKey: config.apiKey,
      baseUrl: config.baseUrl ?? defaultBaseUrl,
      model: config.model,
      maxRetries: config.maxRetries ?? 6,
      requestTimeoutMs: config.requestTimeoutMs ?? 120_000
    };
  }

  async chat(messages: ModelMessage[], tools: ModelToolSchema[]): Promise<ModelResponse> {
    const body = {
      model: this.config.model,
      messages: messages.map(toWireMessage),
      ...(tools.length > 0
        ? {
            tools: tools.map((tool) => ({
              type: "function",
              function: { name: tool.name, description: tool.description, parameters: tool.parameters }
            })),
            tool_choice: "auto"
          }
        : {})
    };

    return this.withRetry(async () => {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), this.config.requestTimeoutMs);
      try {
        const response = await fetch(`${this.config.baseUrl}/chat/completions`, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${this.config.apiKey}`
          },
          body: JSON.stringify(body),
          signal: controller.signal
        });

        if (!response.ok) {
          const text = await response.text().catch(() => "");
          const retryAfterMs = response.status === 429 ? parseRetryAfterMs(response.headers.get("retry-after"), text) : undefined;
          throw new ModelHttpError(
            response.status,
            `Model request failed (${response.status}): ${text.slice(0, 500)}`,
            retryAfterMs
          );
        }

        const payload = (await response.json()) as Record<string, unknown>;
        return parseChatResponse(payload);
      } finally {
        clearTimeout(timeout);
      }
    });
  }

  private async withRetry<T>(fn: () => Promise<T>): Promise<T> {
    let lastError: unknown;
    for (let attempt = 0; attempt <= this.config.maxRetries; attempt++) {
      try {
        return await fn();
      } catch (error) {
        lastError = error;
        if (!isRetryable(error) || attempt === this.config.maxRetries) {
          throw error;
        }
        const backoffMs = Math.min(2 ** attempt * 500, 15_000) + Math.floor(Math.random() * 250);
        const suggestedMs = error instanceof ModelHttpError ? error.retryAfterMs : undefined;
        const sleepMs = suggestedMs ? Math.min(Math.max(suggestedMs, backoffMs), maxRetryAfterMs) : backoffMs;
        const reason = error instanceof Error ? error.message : String(error);
        console.warn(`[model] Request failed (attempt ${attempt + 1}/${this.config.maxRetries}): ${reason}. Waiting ${(sleepMs / 1000).toFixed(1)}s before retry...`);
        await sleep(sleepMs);
      }
    }
    throw lastError;
  }
}

function isRetryable(error: unknown): boolean {
  if (error instanceof ModelHttpError) {
    return error.status === 429 || error.status >= 500;
  }
  if (error instanceof Error) {
    return error.name === "AbortError" || /network|fetch failed|ECONNRESET|ETIMEDOUT/i.test(error.message);
  }
  return false;
}

export function parseRetryAfterMs(header: string | null, bodyText: string): number | undefined {
  if (header) {
    const seconds = Number(header);
    if (Number.isFinite(seconds)) return seconds * 1000;
    const dateMs = Date.parse(header);
    if (!Number.isNaN(dateMs)) return Math.max(0, dateMs - Date.now());
  }
  const match = bodyText.match(/try again in\s+([\d.]+)\s*(ms|s)\b/i);
  if (match) {
    const value = Number(match[1]);
    if (Number.isFinite(value)) return match[2].toLowerCase() === "ms" ? value : value * 1000;
  }
  return undefined;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function toWireMessage(message: ModelMessage): Record<string, unknown> {
  switch (message.role) {
    case "system":
    case "user":
      return { role: message.role, content: message.content };
    case "assistant":
      return {
        role: "assistant",
        content: message.content,
        ...(message.toolCalls && message.toolCalls.length > 0
          ? {
              tool_calls: message.toolCalls.map((call) => ({
                id: call.id,
                type: "function",
                function: { name: call.name, arguments: JSON.stringify(call.arguments) }
              }))
            }
          : {})
      };
    case "tool":
      return { role: "tool", tool_call_id: message.toolCallId, content: message.content };
  }
}

function parseChatResponse(payload: Record<string, unknown>): ModelResponse {
  const choices = payload.choices;
  if (!Array.isArray(choices) || choices.length === 0 || !isRecord(choices[0])) {
    throw new Error("Model response did not include any choices");
  }
  const choice = choices[0];
  const message = isRecord(choice.message) ? choice.message : {};
  const rawToolCalls = Array.isArray(message.tool_calls) ? message.tool_calls : [];

  const toolCalls: ModelToolCall[] = rawToolCalls.map((raw, index) => {
    if (!isRecord(raw)) throw new Error(`Malformed tool call at index ${index}`);
    const fn = isRecord(raw.function) ? raw.function : {};
    const name = typeof fn.name === "string" ? fn.name : undefined;
    if (!name) throw new Error(`Tool call at index ${index} is missing a function name`);
    let args: Record<string, unknown> = {};
    if (typeof fn.arguments === "string" && fn.arguments.length > 0) {
      try {
        args = JSON.parse(fn.arguments) as Record<string, unknown>;
      } catch {
        throw new Error(`Tool call "${name}" returned arguments that were not valid JSON`);
      }
    }
    return { id: typeof raw.id === "string" ? raw.id : `call_${index}`, name, arguments: args };
  });

  const usageRaw = isRecord(payload.usage) ? payload.usage : undefined;

  return {
    content: typeof message.content === "string" ? message.content : null,
    toolCalls,
    finishReason: typeof choice.finish_reason === "string" ? choice.finish_reason : "unknown",
    ...(usageRaw
      ? {
          usage: {
            promptTokens: numberOr(usageRaw.prompt_tokens, 0),
            completionTokens: numberOr(usageRaw.completion_tokens, 0),
            totalTokens: numberOr(usageRaw.total_tokens, 0)
          }
        }
      : {})
  };
}

function numberOr(value: unknown, fallback: number): number {
  return typeof value === "number" ? value : fallback;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

export function modelClientFromEnv(): ModelClient | undefined {
  const apiKey = process.env.AI_API_KEY;
  if (!apiKey) return undefined;

  return new ModelClient({
    apiKey,
    baseUrl: process.env.AI_BASE_URL || defaultBaseUrl,
    model: process.env.AI_MODEL || process.env.MODEL_NAME || "gpt-4.1-mini"
  });
}
