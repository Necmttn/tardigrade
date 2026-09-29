import { Chunk, Schema } from "effect"
import { RecordedEvent, type Event } from "@clavia/tardigrade-core/event"
import type { Machine } from "@clavia/tardigrade-core/machine"
import { component, type ComponentStateSchema } from "@clavia/tardigrade-core/actor"
import type { AgentComponent } from "./view"

export type SystemText = string | ((log: ReadonlyArray<Event>) => string)

// SystemProjection declares the event machine that produces log-dependent instructions.
export type SystemProjection<State> = Machine<Event, State, string> & { readonly state?: ComponentStateSchema<State> }

// system contributes instructions derived from the current log.
export const system = <State = never>(text: SystemText | SystemProjection<State>, options: { readonly name?: string } = {}): AgentComponent => {
  const derive = (value: string) => ({
    view: {
      system: [value],
      tools: [],
      context: [],
      output: []
    },
    transitions: []
  })
  if (typeof text === "object") {
    return component({
      name: options.name ?? "system",
      ...(text.state === undefined ? {} : { state: text.state }),
      initial: () => text.initial(),
      step: text.step,
      output: (state) => ({ ...derive(text.output(state)) })
    })
  }
  return typeof text === "function"
    ? component({
        name: options.name ?? "system",
        state: { version: "1", schema: Schema.toCodecJson(Schema.Chunk(RecordedEvent)) },
        initial: () => Chunk.empty<Event>(),
        step: (state, event) => Chunk.append(state, event),
        output: state => derive(text(Chunk.toReadonlyArray(state)))
      })
    : component({
        name: options.name ?? "system",
        state: { version: "1", schema: Schema.String },
        initial: () => text,
        step: (state: string) => state,
        output: (state) => ({ ...derive(state) })
      })
}
