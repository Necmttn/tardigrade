import { Effect, Layer, ManagedRuntime, Result, Schema } from "effect"
import { HttpRouter, HttpServer, HttpServerRequest, HttpServerResponse } from "effect/unstable/http"
import * as NetAddress from "effect/unstable/net/NetAddress"
import { BunHttpServer } from "@effect/platform-bun"
import { InvocationConflict, RuntimeError, type InvocationReceipt, type ThreadCoordinate } from "@clavia/tardigrade-experimental-core"

interface HttpThread {
  readonly coordinate: ThreadCoordinate
  readonly methods: Readonly<Record<string, (...args: never[]) => Promise<InvocationReceipt>>>
  readonly invocation: (key: string) => InvocationReceipt | undefined
}
interface HttpHost {
  readonly actor: string
  readonly allocateRootThread: (input: { instance: string; name?: string }) => Promise<HttpThread>
  readonly allocateChildThread: (input: { parent: ThreadCoordinate; name?: string }) => Promise<HttpThread>
  readonly getThread: (input: { instance: string; thread: string }) => Promise<HttpThread | undefined>
}

export const DEFAULT_SERVE_OPTIONS = { hostname: "127.0.0.1", port: 4242, idleTimeoutSeconds: 0 } as const
export interface ServeOptions {
  readonly hostname?: string
  readonly port?: number
  readonly idleTimeoutSeconds?: number
}
class HttpError extends Error {
  constructor(readonly status: number, message: string) { super(message) }
}
const attempt = <Value>(run: () => Promise<Value>) => Effect.tryPromise({ try: run, catch: cause => cause instanceof InvocationConflict ? cause : RuntimeError.from(cause) })
const respond = <Error, Services>(handler: Effect.Effect<HttpServerResponse.HttpServerResponse, Error, Services>) => handler.pipe(
  Effect.catch(error => Effect.succeed(HttpServerResponse.jsonUnsafe({ error: error instanceof Error ? error.message : String(error) }, {
    status: error instanceof HttpError ? error.status : error instanceof InvocationConflict ? 409 : 500,
  }))),
)
const AllocationInput = Schema.Struct({ name: Schema.optionalKey(Schema.NonEmptyString.check(Schema.isPattern(/^[^/]+$/))), parent: Schema.optionalKey(Schema.NonEmptyString) })
const base = "/v1/actors/:instance/threads"

// serve binds the host to Effect HTTP; closing the server leaves host ownership with the caller.
export async function serve(host: HttpHost, options: ServeOptions = {}) {
  const routes = Layer.mergeAll(
    HttpRouter.add("POST", base, respond(Effect.gen(function* () {
      const { instance } = yield* HttpRouter.params
      const input = yield* HttpServerRequest.schemaBodyJson(AllocationInput, { onExcessProperty: "error" }).pipe(Effect.mapError(() => new HttpError(400, "Expected { name?: string, parent?: string }")))
      if (input.parent !== undefined && ! (yield* attempt(() => host.getThread({ instance: instance!, thread: input.parent! })))) return yield* Effect.fail(new HttpError(404, "Unknown parent thread"))
      const name = input.name === undefined ? {} : { name: input.name }
      const thread = yield* attempt(() => input.parent === undefined
        ? host.allocateRootThread({ instance: instance!, ...name })
        : host.allocateChildThread({ parent: { actor: host.actor, instance: instance!, thread: input.parent }, ...name }))
      return HttpServerResponse.jsonUnsafe(thread.coordinate, { status: 200 })
    }))),
    HttpRouter.add("POST", `${base}/:thread/methods/:method`, request => respond(Effect.gen(function* () {
      const { instance, thread: id, method } = yield* HttpRouter.params
      const key = request.headers["idempotency-key"]
      if (!key?.trim()) return yield* Effect.fail(new HttpError(400, "Idempotency-Key is required"))
      const input = yield* request.json.pipe(Effect.mapError(() => new HttpError(400, "Invalid JSON body")))
      const thread = yield* attempt(() => host.getThread({ instance: instance!, thread: id! }))
      if (!thread || !Object.hasOwn(thread.methods, method!)) return yield* Effect.fail(new HttpError(404, "Unknown thread or method"))
      const receipt = yield* attempt(() => thread.methods[method!]!(...([input, { key }] as never[])))
      const location = `/v1/actors/${encodeURIComponent(instance!)}/threads/${encodeURIComponent(id!)}/invocations/${encodeURIComponent(key)}`
      return HttpServerResponse.jsonUnsafe(receipt, { status: 202, headers: { location } })
    }))),
    HttpRouter.add("GET", `${base}/:thread/invocations/:key`, respond(Effect.gen(function* () {
      const { instance, thread: id, key } = yield* HttpRouter.params
      const thread = yield* attempt(() => host.getThread({ instance: instance!, thread: id! }))
      const receipt = thread?.invocation(key!)
      if (!receipt) return yield* Effect.fail(new HttpError(404, "Unknown invocation"))
      return HttpServerResponse.jsonUnsafe(receipt)
    }))),
  )
  const runtime = ManagedRuntime.make(HttpRouter.serve(routes, { disableLogger: true, disableListenLog: true }).pipe(
    Layer.provideMerge(BunHttpServer.layer({
      hostname: options.hostname ?? DEFAULT_SERVE_OPTIONS.hostname,
      port: options.port ?? DEFAULT_SERVE_OPTIONS.port,
      idleTimeout: options.idleTimeoutSeconds ?? DEFAULT_SERVE_OPTIONS.idleTimeoutSeconds,
    })),
  ))
  try {
    const server = await runtime.runPromise(HttpServer.HttpServer)
    if (NetAddress.isUnixPathAddress(server.address)) throw new Error("Expected a TCP server")
    return { port: server.address.port, url: Result.getOrThrow(NetAddress.toUrl(server.address)), close: () => runtime.dispose() }
  } catch (error) { await runtime.dispose(); throw error }
}
