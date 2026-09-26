import { Schema } from "effect"
import type { InteractionName } from "./machine"

export type InteractionSchemas = Readonly<Record<string, Schema.ConstraintDecoder<unknown>>>
export type SchemasFor<Input> = {
  readonly [Name in InteractionName<Input>]: Schema.ConstraintDecoder<
    Input extends string ? Extract<Input, Name> : Extract<Input, { readonly type: Name }>
  >
}

type SchemaValues<T> = T extends InteractionSchemas ? T[keyof T] : never
export type InputsOf<Schemas extends InteractionSchemas> = SchemaValues<Schemas>["Type"]

// validateInteraction checks a decoded input against the schema offered at the current position.
// Codec decoding belongs to the caller; type-side validation avoids decoding a routed value twice.
export function validateInteraction(schemas: InteractionSchemas, input: unknown): { readonly name: string; readonly value: unknown } {
  const name = typeof input === "string" ? input
    : typeof input === "object" && input !== null && "type" in input ? input.type : undefined
  if (typeof name !== "string" || !Object.hasOwn(schemas, name)) {
    throw new Error(`Interaction "${String(name)}" is unavailable at the current position`)
  }
  const value = Schema.decodeUnknownSync(Schema.toType(schemas[name]!), { onExcessProperty: "error" })(input)
  const decodedName = typeof value === "string" ? value
    : typeof value === "object" && value !== null && "type" in value ? value.type : undefined
  if (decodedName !== name) throw new Error(`Interaction schema must preserve its name: ${name}`)
  return { name, value }
}
