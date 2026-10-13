import { expect, test } from "bun:test"
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { Effect, Fiber } from "effect"
import { FetchHttpClient } from "effect/unstable/http"
import { AUTH_DEFAULTS, CodexAuthError, credentialsFromTokens, deviceLogin, type Tokens } from "./codex-auth"
import { oauthFixture } from "../testing/fixtures/oauth"

const authFixture = (options: { readonly loginStatus?: number; readonly stallLogin?: boolean; readonly holdRefresh?: boolean } = {}) => {
  const stalled = Promise.withResolvers<Response>()
  const fixture = oauthFixture({
    clientId: AUTH_DEFAULTS.clientId,
    accessToken: generation => `header.${Buffer.from(JSON.stringify({ exp: generation === 0 ? 0 : 9_999_999_999, "https://api.openai.com/auth": { chatgpt_account_id: "fixture-account" } })).toString("base64url")}.signature`,
    authorization: { code: "authorization", verifier: "verifier", redirectPath: "/deviceauth/callback" },
    ...(options.holdRefresh === undefined ? {} : { holdRefresh: options.holdRefresh }),
    route: ({ path, body, approved }) => {
      if (path === "/api/accounts/deviceauth/usercode") {
        if (options.stallLogin) return stalled.promise
        if (options.loginStatus !== undefined) return Response.json({ secret: "private-secret" }, { status: options.loginStatus })
        if (body.client_id !== AUTH_DEFAULTS.clientId) return new Response("Invalid client", { status: 400 })
        return Response.json({ device_auth_id: "device", user_code: "fixture-code", interval: 0.001 })
      }
      if (path === "/api/accounts/deviceauth/token") {
        if (body.device_auth_id !== "device" || body.user_code !== "fixture-code") return new Response("Invalid device", { status: 400 })
        return approved
          ? Response.json({ authorization_code: "authorization", code_verifier: "verifier" })
          : new Response("Pending", { status: 403 })
      }
      return undefined
    }
  })
  return { ...fixture, close: () => { stalled.resolve(new Response("Closed", { status: 503 })); fixture.close() } }
}

const login = (fixture: ReturnType<typeof authFixture>) => deviceLogin(code => Effect.sync(() => {
  expect(code).toEqual({ url: `${fixture.issuer}/codex/device`, code: "fixture-code" })
  fixture.approve()
}), { issuer: fixture.issuer, pollMs: 1 })

const persist = (file: string) => (tokens: Tokens) => Effect.tryPromise({
  try: () => writeFile(file, JSON.stringify(tokens), { mode: 0o600 }),
  catch: () => new CodexAuthError({ message: "Cannot persist fixture credentials" })
})

for (const cancel of [false, true]) {
  test(`HTTP login and renewal persist across restart${cancel ? " after caller cancellation" : " with concurrent callers"}`, async () => {
    const fixture = authFixture({ holdRefresh: true })
    const directory = await mkdtemp(join(tmpdir(), "codex-auth-"))
    const file = join(directory, "credentials.json")
    try {
      await Effect.runPromise(Effect.gen(function* () {
        const initial = yield* login(fixture)
        yield* persist(file)(initial)
        const auth = yield* credentialsFromTokens(initial, { issuer: fixture.issuer }, persist(file))
        const first = yield* auth.credentials.pipe(Effect.forkChild)
        yield* Effect.promise(() => fixture.rotated)
        if (cancel) yield* Effect.sync(() => first.interruptUnsafe())
        const second = yield* auth.credentials.pipe(Effect.forkChild)
        fixture.release()
        if (cancel) yield* Fiber.await(first)
        else expect((yield* Fiber.join(first)).accountId).toBe("fixture-account")
        expect((yield* Fiber.join(second)).accountId).toBe("fixture-account")
        const persisted: Tokens = JSON.parse(yield* Effect.promise(() => readFile(file, "utf8")))
        expect(persisted.refreshToken).toBe("refresh-1")
        expect(fixture.requests.filter(request => request.body.grant_type === "refresh_token").map(request => request.body.refresh_token)).toEqual(["refresh-0"])
        const restarted = yield* credentialsFromTokens({ ...persisted, expiresAt: 0 }, { issuer: fixture.issuer }, persist(file))
        expect((yield* restarted.credentials).accountId).toBe("fixture-account")
        const afterRestart: Tokens = JSON.parse(yield* Effect.promise(() => readFile(file, "utf8")))
        expect(afterRestart.refreshToken).toBe("refresh-2")
        expect(fixture.requests.filter(request => request.body.grant_type === "refresh_token").map(request => request.body.refresh_token)).toEqual(["refresh-0", "refresh-1"])
      }).pipe(Effect.provide(FetchHttpClient.layer), Effect.timeout(2000)))
    } finally {
      fixture.close()
      await rm(directory, { recursive: true, force: true })
    }
  })
}

test("valid credentials make no HTTP requests", async () => {
  const fixture = authFixture()
  try {
    const value = await Effect.runPromise(Effect.gen(function* () {
      const auth = yield* credentialsFromTokens({ accessToken: "token", accountId: "account", refreshToken: "refresh", expiresAt: 9_999_999_999_000 }, { issuer: fixture.issuer })
      return yield* auth.credentials
    }).pipe(Effect.provide(FetchHttpClient.layer)))
    expect(value.accessToken).toBe("token")
    expect(fixture.requests).toHaveLength(0)
  } finally { fixture.close() }
})

test("HTTP authentication failures exclude response contents", async () => {
  const fixture = authFixture({ loginStatus: 401 })
  try {
    const result = await Effect.runPromise(login(fixture).pipe(Effect.provide(FetchHttpClient.layer), Effect.result))
    expect(result._tag).toBe("Failure")
    if (result._tag === "Failure") {
      expect(result.failure.message).toContain("authentication response")
      expect(JSON.stringify(result.failure)).not.toContain("private-secret")
    }
  } finally { fixture.close() }
})

test("failed persistence retries the rotated token without another HTTP exchange", async () => {
  const fixture = authFixture()
  let saves = 0
  try {
    await Effect.runPromise(Effect.gen(function* () {
      const initial = yield* login(fixture)
      const auth = yield* credentialsFromTokens(initial, { issuer: fixture.issuer }, tokens => Effect.suspend(() => {
        saves++
        expect(tokens.refreshToken).toBe("refresh-1")
        return saves === 1 ? Effect.fail(new CodexAuthError({ message: "Storage unavailable" })) : Effect.void
      }))
      expect((yield* Effect.result(auth.credentials))._tag).toBe("Failure")
      expect((yield* auth.credentials).accountId).toBe("fixture-account")
    }).pipe(Effect.provide(FetchHttpClient.layer)))
    expect(fixture.requests.filter(request => request.body.grant_type === "refresh_token")).toHaveLength(1)
    expect(saves).toBe(2)
  } finally { fixture.close() }
})

test("HTTP authentication request timeout is configurable", async () => {
  const fixture = authFixture({ stallLogin: true })
  try {
    const result = await Effect.runPromise(deviceLogin(() => Effect.void, { issuer: fixture.issuer, requestMs: 20 }).pipe(Effect.provide(FetchHttpClient.layer), Effect.result))
    expect(result._tag).toBe("Failure")
    expect(fixture.requests).toHaveLength(1)
  } finally { fixture.close() }
})

test("HTTP refresh timeout remains bounded during protected renewal", async () => {
  const fixture = authFixture({ holdRefresh: true })
  try {
    const result = await Effect.runPromise(Effect.gen(function* () {
      const initial = yield* login(fixture)
      const auth = yield* credentialsFromTokens(initial, { issuer: fixture.issuer, requestMs: 50 })
      return yield* Effect.result(auth.credentials)
    }).pipe(Effect.provide(FetchHttpClient.layer)))
    expect(result._tag).toBe("Failure")
    expect(fixture.requests.filter(request => request.body.grant_type === "refresh_token")).toHaveLength(1)
  } finally { fixture.close() }
})
