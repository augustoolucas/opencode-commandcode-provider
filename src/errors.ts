/**
 * Wrap any error shape (Error, string, SSE plain object like
 * `{ type: "server_error", message: "Network connection lost." }`)
 * into a real Error with the original object preserved on `ccError`
 * and the type exposed as `code` so retry/classification logic can
 * inspect it without parsing strings.
 *
 * Used by both parseStreamEvents (stream-level SSE errors) and
 * streamWithReconnect (model-level reconnect failures).
 */
export function wrapAsError(err: unknown): Error {
  if (err instanceof Error) return err
  if (typeof err === "string") return new Error(err)
  if (err && typeof err === "object") {
    const e = err as Record<string, unknown>
    const nested = e.error as Record<string, unknown> | undefined
    const message =
      (typeof e.message === "string" && e.message) ||
      (typeof nested?.message === "string" && nested.message) ||
      (typeof e.msg === "string" && e.msg) ||
      (() => {
        try {
          return JSON.stringify(err)
        } catch {
          return "Unknown error"
        }
      })()
    const type =
      (typeof e.type === "string" && e.type) ||
      (typeof nested?.type === "string" && nested.type) ||
      undefined
    const error = new Error(type ? `${type}: ${message}` : String(message))
    Object.assign(error, { ccError: err, ...(type ? { code: type } : {}) })
    return error
  }
  return new Error(String(err ?? "Unknown error"))
}
