import { Schema } from "effect"
import type { Token } from "./ports"

// ActorMethod binds an external input schema to a machine input token.
export interface ActorMethod {
  readonly input: Schema.ConstraintDecoder<unknown>
  readonly port: { readonly id: symbol; readonly name: string }
}

// method binds a schema to a port accepting its decoded payload type.
export function method<const Input extends Schema.ConstraintDecoder<unknown>>(
  input: Input,
  port: Token<NoInfer<Input["Type"]>>,
) {
  return { input, port }
}

// decodeMethod validates an external payload before delivery to the bound input port.
export function decodeMethod(method: ActorMethod, input: unknown): unknown {
  return Schema.decodeUnknownSync(method.input, { onExcessProperty: "error" })(input)
}
