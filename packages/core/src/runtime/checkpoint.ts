import { Schema } from "effect"

// ActorCheckpoint identifies a committed prefix of an immutable stream and its runtime state (checkpoint.properties.test.ts).
export const ActorCheckpoint = Schema.Struct({
  actor: Schema.String,
  version: Schema.String,
  stream: Schema.String,
  watermark: Schema.Int,
  recorded: Schema.Array(Schema.String),
  projections: Schema.Array(Schema.Json),
  control: Schema.optionalKey(Schema.Json),
  trigger: Schema.optionalKey(Schema.Struct({ traceId: Schema.String, spanId: Schema.String }))
})
export type ActorCheckpoint = typeof ActorCheckpoint.Type

// ActorCheckpointIdentity binds snapshots to an immutable stream and an explicitly versioned runtime definition.
export interface ActorCheckpointIdentity {
  readonly actor: string
  readonly version: string
  readonly stream: string
}

// ActorRecovery reports whether initialization replayed history or accepted a checkpoint.
export type ActorRecovery =
  | { readonly kind: "pending" }
  | { readonly kind: "replay"; readonly reason?: string }
  | { readonly kind: "checkpoint"; readonly watermark: number }

// ActorReconcilerOptions enables checkpoint capture and supplies an optional untrusted recovery candidate.
export interface ActorReconcilerOptions {
  readonly checkpoint: ActorCheckpointIdentity
  readonly restore?: unknown
}
