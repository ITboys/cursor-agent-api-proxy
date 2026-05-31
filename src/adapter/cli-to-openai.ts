/**
 * Convert Cursor CLI output events into OpenAI Chat Completion format.
 */

import type {
  OpenAIChatResponse,
  OpenAIChatChunk,
} from "../types/openai.js";

export function createStreamChunk(
  requestId: string,
  model: string,
  text: string,
  isFirst: boolean
): OpenAIChatChunk {
  return {
    id: `chatcmpl-${requestId}`,
    object: "chat.completion.chunk",
    created: Math.floor(Date.now() / 1000),
    model,
    choices: [
      {
        index: 0,
        delta: {
          role: isFirst ? "assistant" : undefined,
          content: text,
        },
        finish_reason: null,
      },
    ],
  };
}

export function createDoneChunk(
  requestId: string,
  model: string
): OpenAIChatChunk {
  return {
    id: `chatcmpl-${requestId}`,
    object: "chat.completion.chunk",
    created: Math.floor(Date.now() / 1000),
    model,
    choices: [
      {
        index: 0,
        delta: {},
        finish_reason: "stop",
      },
    ],
  };
}

/** Usage-only chunk — new-api Claude stream converter waits for this before message_stop. */
export function createUsageChunk(
  requestId: string,
  model: string,
  completionTokens: number
): Record<string, unknown> {
  return {
    id: `chatcmpl-${requestId}`,
    object: "chat.completion.chunk",
    created: Math.floor(Date.now() / 1000),
    model,
    choices: [],
    usage: {
      prompt_tokens: 0,
      completion_tokens: completionTokens,
      total_tokens: completionTokens,
    },
  };
}

export function createChatResponse(
  requestId: string,
  model: string,
  text: string
): OpenAIChatResponse {
  return {
    id: `chatcmpl-${requestId}`,
    object: "chat.completion",
    created: Math.floor(Date.now() / 1000),
    model,
    choices: [
      {
        index: 0,
        message: {
          role: "assistant",
          content: text,
        },
        finish_reason: "stop",
      },
    ],
    usage: {
      prompt_tokens: 0,
      completion_tokens: 0,
      total_tokens: 0,
    },
  };
}
