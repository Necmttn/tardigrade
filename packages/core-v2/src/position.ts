import type { Schema } from "effect"
import type { OutputPort } from "./ports"
import type { InteractionSchemas } from "./interactions"

// Position describes public view fields and the interactions and outputs available with those fields.
export interface Position<
  View extends Schema.Struct<Schema.Struct.Fields> = Schema.Struct<Schema.Struct.Fields>,
  Interactions extends InteractionSchemas = InteractionSchemas,
  Name extends string = string,
> {
  readonly view: View
  readonly outputs?: readonly OutputPort<View["Type"] & { readonly position: Name }>[]
  readonly interactions: Interactions | ((view: View["Type"] & { readonly position: Name }) => Interactions)
}
