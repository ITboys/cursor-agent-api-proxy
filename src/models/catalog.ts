/**
 * Single source of truth for Cursor CLI model ids used by /v1/models,
 * extractModel, and account allowlists.
 *
 * Keep in sync with `agent --list-models` when Cursor ships new ids.
 */

export const KNOWN_MODELS = [
  "auto",
  "composer-1.5",
  "composer-1",
  "opus-4.6-thinking",
  "opus-4.6",
  "opus-4.5-thinking",
  "opus-4.5",
  "sonnet-4.5-thinking",
  "sonnet-4.5",
  "gpt-5.3-codex",
  "gpt-5.3-codex-fast",
  "gpt-5.3-codex-low",
  "gpt-5.3-codex-low-fast",
  "gpt-5.3-codex-high",
  "gpt-5.3-codex-high-fast",
  "gpt-5.3-codex-xhigh",
  "gpt-5.3-codex-xhigh-fast",
  "gpt-5.3-codex-spark-preview",
  "gpt-5.2",
  "gpt-5.2-high",
  "gpt-5.2-codex",
  "gpt-5.2-codex-low",
  "gpt-5.2-codex-low-fast",
  "gpt-5.2-codex-high",
  "gpt-5.2-codex-high-fast",
  "gpt-5.2-codex-xhigh",
  "gpt-5.2-codex-xhigh-fast",
  "gpt-5.2-codex-fast",
  "gpt-5.1-codex-max",
  "gpt-5.1-codex-max-high",
  "gpt-5.1-high",
  "gemini-3-pro",
  "gemini-3-flash",
  "grok",
] as const;

const KNOWN_SET = new Set<string>(KNOWN_MODELS);

export function isKnownModel(model: string): boolean {
  return KNOWN_SET.has(model);
}

/**
 * Optional account allowlist. Empty / undefined → all models allowed.
 */
export function isModelAllowed(
  allowlist: string[] | undefined,
  model: string
): boolean {
  if (!allowlist || allowlist.length === 0) return true;
  return allowlist.includes(model);
}
