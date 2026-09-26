import { Schema } from "effect"
import { defineInterface, defineMachine, type InputPort, type OutputPort, type MachineEffect, type Projection } from "@clavia/tardigrade-core-v2"
import type { AgentEvent } from "./events"

// component binds a supplied projection to a machine whose inputs replace its derived value.
export function component<State, const Name extends string, R = never>(options: {
  readonly name: Name
  readonly schema: Schema.ConstraintDecoder<State>
  readonly initial: State
  readonly state: Projection<AgentEvent, State>
  readonly inputs?: readonly InputPort<State, { readonly type: "Update"; readonly value: State }>[]
  readonly outputs?: readonly OutputPort<{ readonly position: "ready"; readonly value: State }>[]
  readonly effects?: (state: State) => readonly MachineEffect<AgentEvent, Error, R>[]
}) {
  const contract = defineInterface({
    ready: {
      view: Schema.Struct({ value: options.schema }),
      interactions: { Update: Schema.Struct({ type: Schema.Literal("Update"), value: options.schema }) },
      outputs: options.outputs ?? [],
    },
  })
  const machine = defineMachine({
    name: options.name,
    interface: contract,
    initial: options.initial,
    view: state => ({ position: "ready", value: state }),
    transitions: { Update: (_state, event) => event.value },
    inputs: options.inputs ?? [],
    effects: view => options.effects?.(view.value) ?? [],
  })
  return {
    ...machine,
    state: options.state,
    combine: (state: State, incoming: readonly { readonly type: "Update"; readonly value: State }[]) => {
      const patch: Record<string, unknown> = {}
      for (const event of incoming) {
        for (const [key, value] of Object.entries(event.value as object)) {
          if (value === (state as Record<string, unknown>)[key]) continue
          if (Object.hasOwn(patch, key)) throw new Error(`Conflicting input updates for ${options.name}.${key}`)
          patch[key] = value
        }
      }
      return { type: "Update" as const, value: Object.assign({}, state, patch) as State }
    },
  }
}
