import { Schema } from "effect"

export const DEFAULT_ACTOR_PORT = 9876
export const DEFAULT_POLL_MS = 1000
export const DEFAULT_WAIT_MS = 180_000
const origin = `http://127.0.0.1:${process.env.CELLD_DEV_PORT ?? DEFAULT_ACTOR_PORT}`
const vars = await Bun.file(new URL("celld/.dev.vars", import.meta.url)).text()
const token = vars.split("\n").find(line => line.startsWith("TARDIGRADE_TOKEN="))?.slice("TARDIGRADE_TOKEN=".length)
if (!token) throw new Error("Run local.ts first")
const headers = { authorization: `Bearer ${token}`, "content-type": "application/json" }
const signal = AbortSignal.timeout(Number(process.env.ASK_WAIT_MS ?? DEFAULT_WAIT_MS))
const exchange = async (path: string, options: RequestInit = {}): Promise<unknown> => {
  const response = await fetch(`${origin}${path}`, { ...options, headers: { ...headers, ...options.headers }, signal })
  if (!response.ok) throw new Error(`Actor returns ${response.status}`)
  return response.json()
}
const coordinate = Schema.decodeUnknownSync(Schema.Struct({ thread: Schema.String }))(await exchange("/v1/actors/demo/threads", {
  method: "POST", body: JSON.stringify({ name: crypto.randomUUID() })
}))
const path = `/v1/actors/demo/threads/${encodeURIComponent(coordinate.thread)}/methods/message`
const id = crypto.randomUUID()
await exchange(path, { method: "POST", headers: { "idempotency-key": id }, body: JSON.stringify({ text: process.argv[2] ?? "What time is it? Use the tool." }) })
for (;;) {
  const result = Schema.decodeUnknownSync(Schema.Record(Schema.String, Schema.Unknown))(await exchange(`${path}/calls/${id}`))
  if (result.status !== "pending") {
    console.log(result)
    if (result.status !== "completed") process.exitCode = 1
    break
  }
  await Bun.sleep(Number(process.env.ASK_POLL_MS ?? DEFAULT_POLL_MS))
}
