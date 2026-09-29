import { Schema } from "effect"

// ComponentCheckpoint contains a leaf component's versioned, encoded private state (checkpoint.test.ts).
export const ComponentCheckpoint = Schema.Struct({ component: Schema.String, version: Schema.String, state: Schema.Json })
export type ComponentCheckpoint = typeof ComponentCheckpoint.Type

export interface ComponentStateSchema<State> {
  readonly version: string
  readonly schema: Schema.Codec<State, Schema.Json>
}
