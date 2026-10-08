import { Clock, Console, Context, Effect, Layer, Ref, Schema, Semaphore } from "effect"
import { HttpClient, HttpClientRequest, HttpClientResponse } from "effect/unstable/http"
import { RuntimeError } from "tardie/core"

export const AUTH_DEFAULTS = {
  issuer: "https://auth.openai.com",
  clientId: "app_EMoamEEZ73f0CkXaXp7hrann",
  requestMs: 30_000,
  loginMs: 900_000,
  pollMs: 5_000,
  refreshMarginMs: 60_000
}
export type Credentials = { readonly accessToken: string; readonly accountId: string }
type Tokens = Credentials & { readonly refreshToken: string; readonly expiresAt: number }
const record = Schema.decodeUnknownSync(Schema.Record(Schema.String, Schema.Unknown))
const required = Schema.decodeUnknownSync(Schema.NonEmptyString)
const claims = (token: string) => record(JSON.parse(Buffer.from(required(token.split(".")[1]), "base64url").toString("utf8")))

// deviceLogin keeps one account in memory and serializes token renewal.
export const deviceLogin = Effect.fn("deviceLogin")(function* (options = AUTH_DEFAULTS) {
  const http = yield* HttpClient.HttpClient
  const post = (path: string, body: string, contentType = "application/json") => http.execute(
    HttpClientRequest.post(`${options.issuer}${path}`).pipe(HttpClientRequest.bodyText(body, contentType))
  ).pipe(Effect.timeout(options.requestMs))
  const read = Effect.fn(function* (response: HttpClientResponse.HttpClientResponse) {
    if (response.status < 200 || response.status >= 300) return yield* Effect.fail(new RuntimeError(`Authentication returns ${response.status}`))
    const value = yield* response.json.pipe(Effect.timeout(options.requestMs))
    return yield* Effect.try({ try: () => record(value), catch: RuntimeError.from })
  })
  const exchange = Effect.fn(function* (form: Record<string, string>, previous?: Tokens) {
    const body = yield* read(yield* post("/oauth/token", new URLSearchParams({ client_id: options.clientId, ...form }).toString(), "application/x-www-form-urlencoded"))
    return yield* Effect.try({ try: (): Tokens => {
      const accessToken = required(body.access_token)
      const access = claims(accessToken)
      const identity = body.id_token ? claims(required(body.id_token)) : access
      const account = record(identity["https://api.openai.com/auth"] ?? access["https://api.openai.com/auth"] ?? {})
      if (typeof access.exp !== "number" || !Number.isFinite(access.exp)) throw new Error("Missing token expiry")
      return { accessToken, refreshToken: required(body.refresh_token ?? previous?.refreshToken), accountId: required(account.chatgpt_account_id ?? previous?.accountId), expiresAt: access.exp * 1000 }
    }, catch: RuntimeError.from })
  })
  const initial = yield* Effect.gen(function* () {
    const device = yield* read(yield* post("/api/accounts/deviceauth/usercode", JSON.stringify({ client_id: options.clientId })))
    const { id, code, interval } = yield* Effect.try({ try: () => ({ id: required(device.device_auth_id), code: required(device.user_code ?? device.usercode), interval: Number(device.interval) * 1000 }), catch: RuntimeError.from })
    yield* Console.log(`Open ${options.issuer}/codex/device and enter ${code}`)
    for (;;) {
      yield* Effect.sleep(Number.isFinite(interval) && interval > 0 ? Math.max(interval, options.pollMs) : options.pollMs)
      const response = yield* post("/api/accounts/deviceauth/token", JSON.stringify({ device_auth_id: id, user_code: code }))
      if (response.status === 403 || response.status === 404) { yield* response.text; continue }
      const body = yield* read(response)
      const form = yield* Effect.try({ try: () => ({ grant_type: "authorization_code", code: required(body.authorization_code), code_verifier: required(body.code_verifier), redirect_uri: `${options.issuer}/deviceauth/callback` }), catch: RuntimeError.from })
      return yield* exchange(form)
    }
  }).pipe(Effect.timeout(options.loginMs))
  const tokens = yield* Ref.make(initial)
  const lock = yield* Semaphore.make(1)
  return { credentials: lock.withPermits(1)(Effect.gen(function* () {
    let current = yield* Ref.get(tokens)
    if (current.expiresAt <= (yield* Clock.currentTimeMillis) + options.refreshMarginMs) {
      current = yield* exchange({ grant_type: "refresh_token", refresh_token: current.refreshToken }, current)
      yield* Ref.set(tokens, current)
    }
    return { accessToken: current.accessToken, accountId: current.accountId }
  })).pipe(Effect.mapError(RuntimeError.from)) }
})

export class Codex extends Context.Service<Codex, { readonly credentials: Effect.Effect<Credentials, Error> }>()("example/Codex") {
  static readonly layer = Layer.effect(Codex, deviceLogin())
}
