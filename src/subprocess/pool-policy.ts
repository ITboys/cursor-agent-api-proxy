/**
 * Pure policy helpers for the subprocess warm pool.
 * Kept separate so routing / idle / account decisions are unit-testable
 * without spawning a real `agent` CLI.
 */

export const PREWARM_MODEL = "auto";

/** Model to pass to CLI when acquiring (warm or cold). */
export function resolveAcquireModel(requestModel?: string): string {
  if (!requestModel || requestModel === "auto") return PREWARM_MODEL;
  return requestModel;
}

/**
 * Warm processes are always spawned with PREWARM_MODEL ("auto").
 * Specific models must cold-start so `--model` matches the request.
 */
export function canUseWarmPool(requestModel?: string): boolean {
  return resolveAcquireModel(requestModel) === PREWARM_MODEL;
}

/**
 * Defense in depth for start(): if a warm process was spawned with a
 * different model than the request needs, respawn before writing the prompt.
 */
export function warmNeedsRespawn(
  spawnedModel: string,
  requestModel?: string
): boolean {
  const want = resolveAcquireModel(requestModel);
  const have = resolveAcquireModel(spawnedModel);
  return want !== have;
}

/** True when a warm slot has been idle at least ttlMs. */
export function shouldReapWarm(
  idleSince: number,
  now: number,
  ttlMs: number
): boolean {
  return now - idleSince >= ttlMs;
}

/**
 * Only maintain a warm queue for known account ids when accounts are configured.
 * Prevents wrong X-Cursor-Account headers from creating ghost pool keys.
 */
export function shouldPoolAccount(
  accountId: string,
  knownIds: Set<string>,
  hasAccounts: boolean
): boolean {
  if (!hasAccounts) return true;
  return knownIds.has(accountId);
}
