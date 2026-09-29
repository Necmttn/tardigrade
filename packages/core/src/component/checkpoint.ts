import { Schema } from "effect"

export interface ComponentCheckpoint {
  readonly component: string
  readonly version: string
  readonly state: Schema.Json
  readonly children: ReadonlyArray<ComponentCheckpoint>
  readonly binding?: { readonly position: number; readonly at: number }
}

// ComponentCheckpoint stores private data and ordered child checkpoints without runtime handles or cached outputs (checkpoint.test.ts).
export const ComponentCheckpoint: Schema.Codec<ComponentCheckpoint> = Schema.Struct({
  component: Schema.String,
  version: Schema.String,
  state: Schema.Json,
  children: Schema.Array(Schema.suspend(() => ComponentCheckpoint)),
  binding: Schema.optionalKey(Schema.Struct({
    position: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0), Schema.isLessThanOrEqualTo(Number.MAX_SAFE_INTEGER)),
    at: Schema.Finite
  }))
})

export interface ComponentStateSchema<State> {
  readonly version: string
  readonly schema: Schema.Codec<State, Schema.Json>
}
