import { timingSafeEqual } from "node:crypto"
import { Config, Effect, Schema, Stream } from "effect"
import { HttpClient, HttpClientRequest, HttpRouter, HttpServerRequest, HttpServerResponse } from "effect/unstable/http"
import { RuntimeError } from "tardie/core"
import { Codex } from "./auth"

export const DEFAULT_REQUEST_MS = 180_000
export const DEFAULT_BODY_BYTES = 1_048_576
const record = Schema.decodeUnknownSync(Schema.Record(Schema.String, Schema.Unknown))

const convert = (input: unknown) => {
  const body = { ...record(input) }
  if (body.stream !== true) throw new Error("Use stream=true")
  if (typeof body.model !== "string" || !body.model) throw new Error("A model is required")
  const instructions: string[] = []
  if (body.instructions !== undefined) instructions.push(Schema.decodeUnknownSync(Schema.String)(body.instructions))
  if (!Array.isArray(body.input)) throw new Error("input must be an array")
  let conversation = false
  body.input = body.input.filter((value: unknown) => {
    const message = record(value)
    if (message.role !== "system") { conversation = true; return true }
    if (conversation) throw new Error("System messages must precede the conversation")
    if (typeof message.content === "string") instructions.push(message.content)
    else instructions.push(Schema.decodeUnknownSync(Schema.Array(Schema.Struct({ type: Schema.Literal("input_text"), text: Schema.String })))(message.content).map(part => part.text).join("\n"))
    return false
  })
  body.instructions = instructions.join("\n\n")
  body.store = false
  delete body.max_output_tokens
  return body
}

// routes authenticates local requests and forwards the Codex response stream (proxy.test.ts).
export const routes = (key: string) => HttpRouter.add("POST", "/v1/responses", Effect.gen(function* () {
  const request = yield* HttpServerRequest.HttpServerRequest
  const supplied = Buffer.from(request.headers.authorization ?? "")
  const expected = Buffer.from(`Bearer ${key}`)
  if (supplied.length !== expected.length || !timingSafeEqual(supplied, expected)) return HttpServerResponse.empty({ status: 401 })
  const converted = yield* Effect.result(request.json.pipe(
    Effect.flatMap(input => Effect.try({ try: () => convert(input), catch: RuntimeError.from }))
  ))
  if (converted._tag === "Failure") return HttpServerResponse.jsonUnsafe({ error: converted.failure.message }, { status: 400 })
  const codex = yield* Codex
  const credentials = yield* codex.credentials
  const client = yield* HttpClient.HttpClient
  const requestMs = yield* Config.Int("PROXY_REQUEST_MS").pipe(Config.withDefault(DEFAULT_REQUEST_MS))
  const response = yield* client.execute(HttpClientRequest.post("https://chatgpt.com/backend-api/codex/responses").pipe(
    HttpClientRequest.setHeaders({ authorization: `Bearer ${credentials.accessToken}`, "chatgpt-account-id": credentials.accountId, accept: "text/event-stream", originator: "codex_cli_rs" }),
    HttpClientRequest.bodyJsonUnsafe(converted.success)
  )).pipe(Effect.timeout(requestMs))
  if (response.status < 200 || response.status >= 300) {
    yield* Stream.runDrain(response.stream)
    return HttpServerResponse.text(`Codex returns ${response.status}`, { status: response.status })
  }
  return HttpServerResponse.stream(response.stream.pipe(Stream.timeout(requestMs)), { headers: {
    "content-type": "text/event-stream", "cache-control": "no-store", "x-codex-output-limit": "enforcement=none"
  } })
}).pipe(Effect.orElseSucceed(() => HttpServerResponse.text("Codex authentication or request failed", { status: 502 }))))
