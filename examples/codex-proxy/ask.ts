import { Config, Console, Crypto, Effect, Schema } from "effect"
import { FileSystem } from "effect/FileSystem"
import { Path } from "effect/Path"
import { HttpClient, HttpClientRequest } from "effect/unstable/http"
import { RuntimeError } from "tardie/core"
import { DEFAULT_ACTOR_PORT } from "./local"

export const DEFAULT_POLL_MS = 1000
export const DEFAULT_WAIT_MS = 180_000
export const ask = Effect.fn("ask")(function* (directory: string, text: string) {
  const fs = yield* FileSystem
  const path = yield* Path
  const crypto = yield* Crypto.Crypto
  const port = yield* Config.Int("CELLD_DEV_PORT").pipe(Config.withDefault(DEFAULT_ACTOR_PORT))
  const pollMs = yield* Config.Int("ASK_POLL_MS").pipe(Config.withDefault(DEFAULT_POLL_MS))
  const vars = yield* fs.readFileString(path.join(directory, "celld/.dev.vars"))
  const token = vars.split("\n").find(line => line.startsWith("TARDIGRADE_TOKEN="))?.slice("TARDIGRADE_TOKEN=".length)
  if (!token) return yield* Effect.fail(new RuntimeError("Run the start command first"))
  const client = (yield* HttpClient.HttpClient).pipe(HttpClient.filterStatusOk, HttpClient.mapRequest(HttpClientRequest.setHeader("authorization", `Bearer ${token}`)))
  const origin = `http://127.0.0.1:${port}/v1/actors/demo/threads`
  const name = yield* crypto.randomUUIDv4
  const allocated = yield* client.execute(HttpClientRequest.post(origin).pipe(HttpClientRequest.bodyJsonUnsafe({ name })))
  const coordinate = yield* Schema.decodeUnknownEffect(Schema.Struct({ thread: Schema.String }))(yield* allocated.json)
  const url = `${origin}/${encodeURIComponent(coordinate.thread)}/methods/message`
  const id = yield* crypto.randomUUIDv4
  const accepted = yield* client.execute(HttpClientRequest.post(url).pipe(HttpClientRequest.setHeader("idempotency-key", id), HttpClientRequest.bodyJsonUnsafe({ text })))
  yield* accepted.text
  for (;;) {
    const response = yield* client.get(`${url}/calls/${id}`)
    const result = yield* Schema.decodeUnknownEffect(Schema.Record(Schema.String, Schema.Unknown))(yield* response.json)
    if (result.status !== "pending") {
      if (result.status !== "completed") return yield* Effect.fail(new RuntimeError(`Actor returns ${result.status}`))
      return yield* Console.log(result.output)
    }
    yield* Effect.sleep(pollMs)
  }
})
