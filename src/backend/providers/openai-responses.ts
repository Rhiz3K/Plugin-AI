import { assertOk, readSseLines } from "./http.js";
import type {
  ChatChunk,
  ChatRequest,
  ProviderConfig,
  ToolCall,
} from "./types.js";
import { AiProviderError } from "./types.js";

// Some models and unverified organizations reject reasoning summaries.
const reasoningDisabled = new Set<string>();

export function resetResponsesMemory(): void {
  reasoningDisabled.clear();
}

export function usesResponsesApi(config: ProviderConfig): boolean {
  if (config.providerType !== "openai") return false;
  const base = config.baseUrl?.trim();
  if (!base) return true;
  try {
    return /(^|\.)api\.openai\.com$/.test(new URL(base).hostname);
  } catch {
    return false;
  }
}

function toResponsesInput(request: ChatRequest): unknown[] {
  const input: unknown[] = [];
  for (const message of request.messages) {
    if (message.role === "tool") {
      input.push({
        type: "function_call_output",
        call_id: message.toolCallId,
        output: message.content,
      });
      continue;
    }

    if (message.role === "assistant" && message.toolCalls?.length) {
      for (const block of message.reasoningState ?? []) {
        if (!block || typeof block !== "object" || Array.isArray(block)) {
          continue;
        }
        const item = block as Record<string, unknown>;
        // With store:false, only encrypted reasoning can be replayed without ids.
        if (item.type !== "reasoning" || !item.encrypted_content) continue;
        const { id: _id, status: _status, ...reasoning } = item;
        input.push(reasoning);
      }
      if (message.content) {
        input.push({ role: "assistant", content: message.content });
      }
      for (const call of message.toolCalls) {
        input.push({
          type: "function_call",
          call_id: call.id,
          name: call.name,
          arguments: JSON.stringify(call.arguments),
        });
      }
      continue;
    }

    if (message.role !== "assistant" || message.content) {
      input.push({ role: message.role, content: message.content });
    }
  }
  return input;
}

export async function* streamResponses(
  config: ProviderConfig,
  request: ChatRequest,
  url: string,
  headers: Record<string, string>,
): AsyncIterable<ChatChunk> {
  const memoryKey = `${url}|${request.model}`;
  let body: Record<string, unknown> = {
    model: request.model,
    instructions: request.system,
    input: toResponsesInput(request),
    stream: true,
    store: false,
    ...(!reasoningDisabled.has(memoryKey)
      ? { reasoning: { summary: "auto" } }
      : {}),
    ...(request.maxTokens !== undefined
      ? { max_output_tokens: request.maxTokens }
      : {}),
    ...(request.tools.length
      ? {
          tools: request.tools.map((tool) => ({
            type: "function",
            name: tool.name,
            description: tool.description,
            parameters: tool.parameters,
            strict: false,
          })),
        }
      : {}),
  };
  const post = (payload: object) =>
    config.fetch(url, {
      method: "POST",
      headers,
      signal: request.signal,
      body: JSON.stringify(payload),
    });

  let response = await post(body);
  if (response.status === 400) {
    const detail = await response.text().catch(() => "");
    if (/reasoning|summar|encrypted/i.test(detail) && body.reasoning) {
      reasoningDisabled.add(memoryKey);
      const { reasoning: _dropped, ...rest } = body;
      body = rest;
      response = await post(body);
    } else {
      response = new Response(detail, {
        status: response.status,
        statusText: response.statusText,
      });
    }
  }
  await assertOk(response, "OpenAI");

  const calls: ToolCall[] = [];
  const reasoning: unknown[] = [];
  let usage: { input_tokens?: number; output_tokens?: number } | null = null;
  let stopReason: string | undefined;
  let previousReasoningKey: string | undefined;

  for await (const data of readSseLines(response)) {
    if (data === "[DONE]") break;
    let frame: any;
    try {
      frame = JSON.parse(data);
    } catch {
      continue;
    }

    switch (frame?.type) {
      case "response.output_text.delta":
      case "response.refusal.delta":
        if (typeof frame.delta === "string" && frame.delta) {
          yield { type: "text", text: frame.delta };
        }
        break;
      case "response.reasoning_summary_text.delta":
      case "response.reasoning_text.delta":
        if (typeof frame.delta === "string" && frame.delta) {
          // Separate summaries and reasoning items only when they have text.
          const key = `${frame.item_id}:${frame.summary_index}`;
          if (
            previousReasoningKey !== undefined &&
            previousReasoningKey !== key
          ) {
            yield { type: "reasoning", text: "\n\n" };
          }
          previousReasoningKey = key;
          yield { type: "reasoning", text: frame.delta };
        }
        break;
      case "response.output_item.done": {
        const item = frame.item;
        if (item?.type === "reasoning") reasoning.push(item);
        if (item?.type !== "function_call" || !item.name) break;
        let args: Record<string, unknown> = {};
        try {
          const parsed = JSON.parse(item.arguments);
          if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
            args = parsed;
          }
        } catch {
          // The tool's schema validation reports malformed arguments.
        }
        calls.push({ id: item.call_id, name: item.name, arguments: args });
        break;
      }
      case "response.completed":
      case "response.incomplete":
        if (frame.response?.usage) usage = frame.response.usage;
        stopReason =
          frame.type === "response.incomplete"
            ? (frame.response?.incomplete_details?.reason ?? "incomplete")
            : calls.length
              ? "tool_calls"
              : "stop";
        break;
      case "response.failed":
        throw new AiProviderError(
          `OpenAI request failed: ${frame.response?.error?.message ?? "the response failed"}`,
        );
      case "error":
        throw new AiProviderError(`OpenAI request failed: ${frame.message}`);
    }
  }

  // A closed connection is only successful after a terminal event.
  if (stopReason === undefined) {
    throw new AiProviderError(
      "OpenAI closed the stream before the response finished.",
    );
  }

  for (const call of calls) yield { type: "tool_call", call };
  if (reasoning.length) yield { type: "reasoning_state", blocks: reasoning };
  if (usage) {
    yield {
      type: "usage",
      usage: {
        promptTokens: Number(usage.input_tokens) || 0,
        completionTokens: Number(usage.output_tokens) || 0,
      },
    };
  }
  yield { type: "done", stopReason };
}
