import { validateView } from "./interface"
import type { Component } from "./compose"
import { validateInteraction, type InputsOf } from "./interactions"

type Definition = Pick<Component, "name" | "initial" | "view" | "interface" | "transitions">
export type MachineInput<M extends Definition> = InputsOf<ReturnType<M["interface"]["interactions"]>>

// MachineInstance exposes a current position and interactions over privately held state.
export interface MachineInstance<M extends Definition> {
  readonly name: M["name"]
  readonly interface: M["interface"]
  readonly view: () => ReturnType<M["view"]>
  readonly interactions: () => ReturnType<M["interface"]["interactions"]>
  readonly interact: (input: MachineInput<M>) => ReturnType<M["view"]>
}

// instantiate binds a machine definition to an in-memory state cell.
// Available schemas validate payloads before a transition executes.
export function instantiate<const M extends Definition>(definition: M): MachineInstance<M> {
  let state: unknown = definition.initial
  const view = (): ReturnType<M["view"]> => validateView(definition.interface.view, definition.view(state as never)) as ReturnType<M["view"]>
  return Object.freeze({
    name: definition.name,
    interface: definition.interface,
    view,
    interactions: () => Object.freeze({ ...definition.interface.interactions(view() as never) }) as ReturnType<M["interface"]["interactions"]>,
    interact: (input: MachineInput<M>) => {
      const current = view()
      const { name, value } = validateInteraction(definition.interface.interactions(current as never), input)
      const mode = typeof current === "string" ? current : current.position
      const transitions = Object.hasOwn(definition.transitions, mode) ? definition.transitions[mode] : undefined
      if (!transitions || !Object.hasOwn(transitions, name)) {
        throw new Error(`No transition for interaction "${name}" at ${definition.name}`)
      }
      const next = transitions[name]!(state as never, value as never)
      const position = validateView(definition.interface.view, definition.view(next as never)) as ReturnType<M["view"]>
      state = next
      return position
    }
  })
}
