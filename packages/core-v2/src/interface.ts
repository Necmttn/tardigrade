import { Schema } from "effect"
import type { InteractionSchemas } from "./interactions"
import type { PublicPosition } from "./machine"
import type { OutputPort } from "./ports"
import type { Position } from "./position"

// MachineInterface describes public positions and the interactions available at each position.
export interface MachineInterface<View extends PublicPosition, Schemas extends InteractionSchemas = InteractionSchemas> {
  readonly view: Schema.ConstraintDecoder<View>
  readonly interactions: (position: View) => Schemas
}

// validateView validates a decoded public position without applying codec transformations.
export function validateView<View extends PublicPosition>(
  schema: Schema.ConstraintDecoder<View>,
  value: unknown,
): View {
  return Schema.decodeUnknownSync(Schema.toType(schema), { onExcessProperty: "error" })(value)
}

type ViewAt<Name extends string, View extends Schema.Struct<Schema.Struct.Fields>> =
  View["Type"] & { readonly position: Name }

type ViewsOf<Views extends Record<string, Schema.Struct<Schema.Struct.Fields>>> = {
  [Name in keyof Views & string]: ViewAt<Name, Views[Name]>
}[keyof Views & string]

declare const positionInteractions: unique symbol

export interface DeclaredMachineInterface<View extends PublicPosition, Interactions extends Record<string, InteractionSchemas>>
  extends MachineInterface<View, Interactions[keyof Interactions]> {
  readonly outputs: readonly OutputPort<View>[]
  readonly positions: readonly (keyof Interactions & string)[]
  readonly [positionInteractions]?: Interactions
}

export type InteractionsByPosition<Contract extends { readonly [positionInteractions]?: Record<string, InteractionSchemas> }> =
  NonNullable<Contract[typeof positionInteractions]>

// Interface maps position names to their view schemas and available interactions.
export type Interface<
  Views extends Record<string, Schema.Struct<Schema.Struct.Fields>>,
  Interactions extends Record<string, InteractionSchemas>,
> = {
  readonly [Name in keyof Views & keyof Interactions]: Position<Views[Name], Interactions[Name], Name & string>
}

// defineInterface groups each position's view fields and available interaction schemas.
// The position tag is supplied by the declaration key and must be absent from its view fields.
export function defineInterface<
  const Views extends Record<string, Schema.Struct<Schema.Struct.Fields>>,
  const Interactions extends Record<string, InteractionSchemas>,
>(positions: Interface<Views, Interactions>): DeclaredMachineInterface<ViewsOf<Views>, Interactions> {
  const entries = Object.entries(positions)
  if (entries.length === 0) throw new Error("An interface requires at least one position")
  const variants = entries.map(([name, definition]) => {
    if (Object.hasOwn(definition.view.fields, "position")) {
      throw new Error(`Position "${name}" must omit the reserved position field`)
    }
    return Schema.toType(Schema.Struct({
      ...definition.view.fields,
      position: Schema.Literal(name),
    }))
  })
  const ports = new Map<symbol, {
    readonly port: OutputPort<never>
    readonly readers: Map<string, OutputPort<never>>
  }>()
  for (const [name, definition] of entries) {
    for (const port of definition.outputs ?? []) {
      const group = ports.get(port.id) ?? { port, readers: new Map<string, OutputPort<never>>() }
      if (group.readers.has(name)) throw new Error(`Duplicate output "${port.name}" at ${name}`)
      if (group.port.broadcast !== port.broadcast) {
        throw new Error(`Output "${port.name}" must use the same broadcast setting at every position`)
      }
      group.readers.set(name, port)
      ports.set(port.id, group)
    }
  }
  const outputs: readonly OutputPort<ViewsOf<Views>>[] = [...ports.values()].map(({ port, readers }) => ({
    id: port.id,
    name: port.name,
    broadcast: port.broadcast,
    read: position => readers.get(position.position)?.read(position as never),
  }))
  const view = Schema.Union(variants) as unknown as Schema.ConstraintDecoder<ViewsOf<Views>>
  return {
    outputs,
    positions: Object.keys(positions) as (keyof Interactions & string)[],
    view,
    interactions: (position) => {
      if (!Object.hasOwn(positions, position.position)) throw new Error(`Unknown position: ${position.position}`)
      const offered = positions[position.position]!.interactions
      return (typeof offered === "function" ? offered(position) : offered) as Interactions[keyof Interactions]
    },
  }
}
