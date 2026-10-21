/**
 * Convert OpenAI Chat Completion requests into a prompt string
 * suitable for the Cursor CLI `agent -p` command.
 */

import type { OpenAIChatMessage, OpenAIChatRequest, OpenAIContentPart } from "../types/openai.js";
import { isKnownModel } from "../models/catalog.js";

export interface CliInput {
  prompt: string;
  model: string;
}

/**
 * Resolve the Cursor CLI model name from an OpenAI-style model string.
 *
 * Supported formats:
 *   "cursor/opus-4.6"     -> "opus-4.6"
 *   "cursor-opus-4.6"     -> "opus-4.6"
 *   "auto"                -> "auto"
 *   "opus-4.6-thinking"   -> "opus-4.6-thinking"
 *
 * Unknown ids map to "auto" (no silent pass-through of garbage).
 */
export function extractModel(model: string): string {
  let candidate = model;

  if (model.startsWith("cursor/")) {
    candidate = model.slice("cursor/".length) || "auto";
  } else if (model.startsWith("cursor-")) {
    candidate = model.slice("cursor-".length) || "auto";
  }

  if (isKnownModel(candidate)) {
    return candidate;
  }

  return "auto";
}

function messageContentToText(content: string | OpenAIContentPart[]): string {
  if (typeof content === "string") return content;

  return content
    .filter((part): part is OpenAIContentPart & { type: "text" } => part.type === "text")
    .map((part) => part.text ?? "")
    .join("");
}

/**
 * Flatten an array of OpenAI messages into a single prompt string.
 *
 * When there's only one user message (the common case), pass the text
 * directly without role markers to keep the prompt clean.
 * Multi-turn conversations get [System]/[User]/[Assistant] prefixes.
 */
export function messagesToPrompt(messages: OpenAIChatMessage[]): string {
  const nonEmpty = messages.filter((m) => {
    const text = messageContentToText(m.content);
    return text.length > 0;
  });

  if (nonEmpty.length === 1 && nonEmpty[0].role === "user") {
    return messageContentToText(nonEmpty[0].content);
  }

  const parts: string[] = [];
  for (const msg of nonEmpty) {
    const text = messageContentToText(msg.content);
    switch (msg.role) {
      case "system":
        parts.push(`[System]\n${text}`);
        break;
      case "user":
        parts.push(`[User]\n${text}`);
        break;
      case "assistant":
        parts.push(`[Assistant]\n${text}`);
        break;
    }
  }

  return parts.join("\n\n");
}

export function openaiToCli(request: OpenAIChatRequest): CliInput {
  return {
    prompt: messagesToPrompt(request.messages),
    model: extractModel(request.model || "auto"),
  };
}
