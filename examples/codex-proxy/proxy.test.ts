import { expect, test } from "bun:test"
import { Effect, Layer } from "effect"
import { HttpClient, HttpClientResponse, HttpRouter } from "effect/unstable/http"
import { AUTH_DEFAULTS, Codex, deviceLogin } from "./auth"
import { routes } from "./proxy"

const credentials = Effect.succeed({ accessToken: "access-token", accountId: "account" })
const request = (body: unknown, key = "local-key") => new Request("http://localhost/v1/responses", {
  method: "POST", headers: { authorization: `Bearer ${key}`, "content-type": "application/json" }, body: JSON.stringify(body)
})
const handler = (client: HttpClient.HttpClient, auth = credentials) => HttpRouter.toWebHandler(routes("local-key").pipe(
  Layer.provideMerge(Layer.merge(Layer.succeed(HttpClient.HttpClient, client), Layer.succeed(Codex, { credentials: auth })))
), { disableLogger: true })

test("converts instructions and preserves tools, reasoning, and SSE bytes", async () => {
  const input = [
    { role: "user", content: "What time is it?" },
    { type: "reasoning", id: "reason", summary: [] },
    { type: "function_call", call_id: "call", name: "current_time", arguments: "{}" },
    { type: "function_call_output", call_id: "call", output: "2026-10-08T00:00:00Z" }
  ]
  const tools = [{ type: "function", name: "current_time", parameters: { type: "object", properties: {} } }]
  const stream = 'event: response.completed\ndata: {"type":"response.completed"}\n\n'
  const client = HttpClient.make(upstream => Effect.sync(() => {
    expect(upstream.headers.authorization).toBe("Bearer access-token")
    expect(upstream.headers["chatgpt-account-id"]).toBe("account")
    if (upstream.body._tag !== "Uint8Array") throw new Error("Expected a JSON request")
    expect(JSON.parse(new TextDecoder().decode(upstream.body.body))).toEqual({
      model: "test-model", stream: true, store: false, instructions: "Existing instructions\n\nKeep answers short.", input, tools
    })
    return HttpClientResponse.fromWeb(upstream, new Response(stream))
  }))
  const web = handler(client)
  try {
    const response = await web.handler(request({
      model: "test-model", stream: true, max_output_tokens: 100, instructions: "Existing instructions",
      input: [{ role: "system", content: [{ type: "input_text", text: "Keep answers short." }] }, ...input], tools
    }))
    expect(response.status).toBe(200)
    expect(response.headers.get("content-type")).toBe("text/event-stream")
    expect(response.headers.get("x-codex-output-limit")).toBe("enforcement=none")
    expect(await response.text()).toBe(stream)
  } finally { await web.dispose() }
})

test("refuses invalid keys before reading credentials", async () => {
  const client = HttpClient.make(() => Effect.die("No upstream request is permitted"))
  const web = handler(client, Effect.die("Credentials must remain private"))
  try { expect((await web.handler(request({}, "wrong-key"))).status).toBe(401) }
  finally { await web.dispose() }
})

test("refuses a system message after conversation begins", async () => {
  const client = HttpClient.make(() => Effect.die("No upstream request is permitted"))
  const web = handler(client)
  try {
    expect((await web.handler(request({ model: "test-model", stream: true, input: [
      { role: "user", content: "Hello" }, { role: "system", content: "Late instructions" }
    ] }))).status).toBe(400)
  } finally { await web.dispose() }
})

test("preserves upstream rejection status", async () => {
  const client = HttpClient.make(upstream => Effect.succeed(HttpClientResponse.fromWeb(upstream, new Response("Rejected", { status: 429 }))))
  const web = handler(client)
  try { expect((await web.handler(request({ model: "test-model", stream: true, input: [] }))).status).toBe(429) }
  finally { await web.dispose() }
})

test("device login renews an expired token once for concurrent requests", async () => {
  const token = (expiresAt: number) => `header.${Buffer.from(JSON.stringify({ exp: expiresAt, "https://api.openai.com/auth": { chatgpt_account_id: "account" } })).toString("base64url")}.signature`
  let refreshes = 0
  const client = HttpClient.make((upstream, url) => Effect.sync(() => {
    let body: unknown
    if (url.pathname.endsWith("/usercode")) body = { device_auth_id: "device", user_code: "code", interval: 0.001 }
    else if (url.pathname.endsWith("/deviceauth/token")) body = { authorization_code: "authorization", code_verifier: "verifier" }
    else {
      if (upstream.body._tag !== "Uint8Array") throw new Error("Expected encoded authentication data")
      const form = new URLSearchParams(new TextDecoder().decode(upstream.body.body))
      const refresh = form.get("grant_type") === "refresh_token"
      if (refresh) {
        refreshes++
        expect(form.get("refresh_token")).toBe("refresh-token")
      }
      body = { access_token: token(refresh ? 9_999_999_999 : 0), refresh_token: "refresh-token" }
    }
    return HttpClientResponse.fromWeb(upstream, Response.json(body))
  }))
  const values = await Effect.runPromise(Effect.gen(function* () {
    const auth = yield* deviceLogin({ ...AUTH_DEFAULTS, issuer: "https://auth.example", pollMs: 1 })
    return yield* Effect.all([auth.credentials, auth.credentials], { concurrency: "unbounded" })
  }).pipe(Effect.provideService(HttpClient.HttpClient, client)))
  expect(refreshes).toBe(1)
  expect(values[0]?.accountId).toBe("account")
  expect(values[0]).toEqual(values[1])
})

test("returns a client error for malformed JSON", async () => {
  const client = HttpClient.make(() => Effect.die("No upstream request is permitted"))
  const web = handler(client)
  try {
    const response = await web.handler(new Request("http://localhost/v1/responses", {
      method: "POST", headers: { authorization: "Bearer local-key", "content-type": "application/json" }, body: "{"
    }))
    expect(response.status).toBe(400)
  } finally { await web.dispose() }
})
