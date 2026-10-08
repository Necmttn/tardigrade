import { expect, test } from "bun:test"
import { proxy } from "./proxy"

const credentials = async () => ({ accessToken: "access-token", accountId: "account" })
const request = (body: unknown, key = "local-key") => new Request("http://localhost/v1/responses", {
  method: "POST",
  headers: { authorization: `Bearer ${key}`, "content-type": "application/json" },
  body: JSON.stringify(body)
})

test("converts instructions and preserves tool and reasoning items through SSE", async () => {
  const input = [
    { role: "user", content: "What time is it?" },
    { type: "reasoning", id: "reason", summary: [] },
    { type: "function_call", call_id: "call", name: "current_time", arguments: "{}" },
    { type: "function_call_output", call_id: "call", output: "2026-10-08T00:00:00Z" }
  ]
  const tools = [{ type: "function", name: "current_time", parameters: { type: "object", properties: {} } }]
  const stream = 'event: response.completed\ndata: {"type":"response.completed"}\n\n'
  const handle = proxy({ key: "local-key", credentials, fetch: async (upstream) => {
    expect(upstream.headers.get("authorization")).toBe("Bearer access-token")
    expect(upstream.headers.get("chatgpt-account-id")).toBe("account")
    const body: unknown = await upstream.json()
    expect(body).toEqual({
      model: "test-model", stream: true, store: false, instructions: "Existing instructions\n\nKeep answers short.", input, tools
    })
    return new Response(stream)
  } })
  const response = await handle(request({
    model: "test-model", stream: true, max_output_tokens: 100,
    instructions: "Existing instructions",
    input: [{ role: "system", content: [{ type: "input_text", text: "Keep answers short." }] }, ...input], tools
  }))
  expect(response.status).toBe(200)
  expect(response.headers.get("content-type")).toBe("text/event-stream")
  expect(response.headers.get("x-codex-output-limit")).toBe("enforcement=none")
  expect(await response.text()).toBe(stream)
})

test("refuses an invalid proxy key before reading credentials", async () => {
  const handle = proxy({ key: "local-key", credentials: () => { throw new Error("Credentials must remain private") } })
  expect((await handle(request({}, "wrong-key"))).status).toBe(401)
})

test("refuses a system message after conversation begins", async () => {
  const handle = proxy({ key: "local-key", credentials })
  const response = await handle(request({ model: "test-model", stream: true, input: [
    { role: "user", content: "Hello" }, { role: "system", content: "Late instructions" }
  ] }))
  expect(response.status).toBe(400)
})

test("preserves upstream rejection status", async () => {
  const handle = proxy({ key: "local-key", credentials, fetch: async () => new Response("Rejected", { status: 429 }) })
  expect((await handle(request({ model: "test-model", stream: true, input: [] }))).status).toBe(429)
})
