// RuntimeError preserves a typed failure at the experimental runtime boundary.
export class RuntimeError extends Error {
  readonly _tag = "RuntimeError"

  static from(cause: unknown): RuntimeError {
    return cause instanceof RuntimeError ? cause : new RuntimeError(cause instanceof Error ? cause.message : String(cause), { cause })
  }
}
