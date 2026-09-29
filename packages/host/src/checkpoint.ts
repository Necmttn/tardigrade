import type { Effect } from "effect"
import type { ActorCheckpoint, ActorCheckpointIdentity, ActorRecovery } from "@clavia/tardigrade-core/runtime"

// ActorCheckpointStore loads a disposable candidate and atomically replaces a complete checkpoint for one immutable stream.
export interface ActorCheckpointStore {
  readonly load: Effect.Effect<unknown>
  readonly save: (checkpoint: ActorCheckpoint) => Effect.Effect<void>
}

// ActorCheckpointPersistence enables saving after successful drives whose published watermark has changed.
export interface ActorCheckpointPersistence {
  readonly identity: ActorCheckpointIdentity
  readonly store: ActorCheckpointStore
  readonly onRecovery?: (recovery: ActorRecovery) => void
}

// checkpointCandidate preserves malformed JSON for the reconciler's observable fallback path.
export const checkpointCandidate = (encoded: string | undefined): unknown => {
  if (encoded === undefined) return undefined
  try { return JSON.parse(encoded) } catch { return encoded }
}
