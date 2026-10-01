// ToolError preserves a typed failure at the experimental runtime boundary.
export class ToolError extends Error {
  readonly _tag = "ToolError"

  static from(cause: unknown): ToolError {
    return cause instanceof ToolError ? cause : new ToolError(cause instanceof Error ? cause.message : String(cause), { cause })
  }
}
