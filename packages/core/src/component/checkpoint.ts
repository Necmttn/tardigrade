import { Schema } from "effect"

// ComponentCheckpoint stores encoded component state and child snapshots (checkpoint.test.ts).
export interface ComponentCheckpoint {
  readonly component: string
  readonly version: string
  readonly state: Schema.Json
  readonly children?: ReadonlyArray<ComponentCheckpoint>
  readonly runtime?: Schema.Json
}

export const ComponentCheckpoint: Schema.Codec<ComponentCheckpoint, Schema.Json> = Schema.Struct({
  component: Schema.String,
  version: Schema.String,
  state: Schema.Json,
  children: Schema.optionalKey(Schema.Array(Schema.suspend(() => ComponentCheckpoint))),
  runtime: Schema.optionalKey(Schema.Json)
})
