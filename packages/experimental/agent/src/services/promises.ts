import { Effect, Schema } from "effect"
import type { ActorRuntime } from "@clavia/tardigrade-experimental-core"
import { PromiseSettled } from "@clavia/tardigrade-experimental-host"
import { Event } from "../event"

// receiveResolution delivers settlements for accepted effects; the runtime checks identity and repeated delivery.
export function receiveResolution(host: ActorRuntime<Event>, settlement: PromiseSettled) {
  return Schema.decodeEffect(PromiseSettled)(settlement).pipe(Effect.flatMap(event => host.send([event])))
}
