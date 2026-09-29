import { Schema } from "effect"
import { pureData } from "@clavia/tardigrade-core/transition/data"
import type { Serve } from "./machine"

// ToolCommand identifies versioned behavior and its durable parameters (checkpoint.properties.test.ts).
export const ToolCommand = Schema.Struct({ implementation: Schema.String, version: Schema.String, input: Schema.Json })
export type ToolCommand = typeof ToolCommand.Type

export interface ToolImplementation<R = never> {
  readonly name: string
  readonly version: string
  readonly validate: (input: unknown) => void
  readonly serve: (input: Schema.Json, ...args: Parameters<Serve<R>>) => ReturnType<Serve<R>>
}

// toolCommand separates durable parameters from behavior installed at component construction (checkpoint.properties.test.ts).
export const toolCommand = <Input, R = never>(options: {
  readonly name: string
  readonly version: string
  readonly schema: Schema.Schema<Input>
  readonly serve: (input: Input, ...args: Parameters<Serve<R>>) => ReturnType<Serve<R>>
}): ToolImplementation<R> & { readonly command: (input: Input) => ToolCommand } => {
  const decode = (input: unknown): Input => Schema.decodeUnknownSync(Schema.toType(options.schema), { onExcessProperty: "error" })(pureData(input))
  return {
    name: options.name, version: options.version,
    validate: input => { pureData(decode(input)) },
    serve: (input, ...args) => options.serve(decode(input), ...args),
    command: input => ({ implementation: options.name, version: options.version, input: pureData(decode(input)) })
  }
}
