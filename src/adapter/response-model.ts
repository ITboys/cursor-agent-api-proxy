/**
 * Model id returned to OpenAI-compatible clients.
 *
 * Cursor CLI may report display names ("Auto", "Claude Sonnet 4.5") which
 * break new-api's OpenAI→Claude stream converter. Always echo the request
 * model id (same policy for stream and non-stream).
 */
export function resolveResponseModel(
  requestModel: string,
  _cliReported?: string
): string {
  return requestModel;
}
