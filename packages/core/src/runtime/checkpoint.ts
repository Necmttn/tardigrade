import { Schema } from "effect"
import { ComponentCheckpoint } from "../component/checkpoint"

// ActorCheckpoint captures one log prefix for checkpointable transition projections (packages/code/src/package/calls.test.ts).
export const ActorCheckpoint = Schema.Struct({
  version: Schema.Literal(1),
  watermark: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0), Schema.isLessThanOrEqualTo(Number.MAX_SAFE_INTEGER)),
  recorded: Schema.Array(Schema.String),
  projections: Schema.Array(ComponentCheckpoint),
  control: Schema.optionalKey(ComponentCheckpoint)
})
export type ActorCheckpoint = typeof ActorCheckpoint.Type
