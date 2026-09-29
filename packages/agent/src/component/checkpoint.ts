import { Schema } from "effect"
import { supportsCheckpoint, type Component } from "@clavia/tardigrade-core/component"

// checkpointFor enables built-in state codecs when every child supports restoration.
export const checkpointFor = <State>(children: ReadonlyArray<Component<unknown, unknown, never, unknown>>, schema: Schema.Codec<State, Schema.Json>, version = "1") =>
  children.every(supportsCheckpoint) ? { checkpoint: { version, schema } } : {}

// checkpointComposition enables recursive sibling snapshots when every child supports restoration.
export const checkpointComposition = (children: ReadonlyArray<Component<unknown, unknown, never, unknown>>) =>
  children.every(supportsCheckpoint) ? { checkpoint: { version: "1" } } : {}
