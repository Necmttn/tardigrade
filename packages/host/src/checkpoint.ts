import { Context, Effect } from "effect"
import type { ActorCheckpoint } from "@clavia/tardigrade-core/runtime"

// ActorCheckpointStore replaces the latest checkpoint for its bound thread log (platform/bun/src/host.test.ts).
export class ActorCheckpointStore extends Context.Service<ActorCheckpointStore, {
  readonly load: Effect.Effect<unknown, Error>
  readonly save: (checkpoint: ActorCheckpoint) => Effect.Effect<void, Error>
}>()("tardigrade/ActorCheckpointStore") {}
