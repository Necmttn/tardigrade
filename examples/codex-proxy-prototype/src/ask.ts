import { resolve } from "node:path"
import { object } from "./auth"

export const ASK_DEFAULTS = { port: 9876, waitMs: 300_000, pollMs: 1_000 }
const number = (name: string, fallback: number) => {
  const value = Number(process.env[name] ?? fallback)
  if (!Number.isSafeInteger(value) || value <= 0) throw new Error(`Invalid ${name}`)
  return value
}
const origin = `http://127.0.0.1:${number("CELLD_DEV_PORT", ASK_DEFAULTS.port)}`
const deadline = AbortSignal.timeout(number("ASK_WAIT_MS", ASK_DEFAULTS.waitMs))
const pollMs = number("ASK_POLL_MS", ASK_DEFAULTS.pollMs)
const vars = await Bun.file(resolve(import.meta.dir, "../celld/.dev.vars")).text()
const token = vars.split("\n").find((line) => line.startsWith("TARDIGRADE_TOKEN="))?.slice("TARDIGRADE_TOKEN=".length)
if (!token) throw new Error("Run local.ts before sending a message")
const headers = { authorization: `Bearer ${token}`, "content-type": "application/json" }
const runId = process.env.DEMO_RUN_ID ?? crypto.randomUUID()
const instance = "demo"
const allocate = await fetch(`${origin}/v1/actors/${instance}/threads`, {
  method: "POST", headers, signal: deadline,
  body: JSON.stringify({ name: `mcp-${runId}` }),
})
if (!allocate.ok) throw new Error(`Thread allocation failed (${allocate.status})`)
const coordinate = object(await allocate.json())
if (typeof coordinate.thread !== "string") throw new Error("Thread coordinate is missing")
const response = await fetch(`${origin}/v1/actors/${instance}/threads/${encodeURIComponent(coordinate.thread)}/methods/message`, {
  method: "POST", headers: { ...headers, "idempotency-key": runId }, signal: deadline,
  body: JSON.stringify({ text: process.env.DEMO_PROMPT ?? "Read my Appllama credits. Then call appllama_list_flows once with query Onboarding. Summarize the returned categories and counts. Do not repeat either successful call." }),
})
if (response.status !== 202) throw new Error(`Message delivery failed (${response.status})`)
const location = response.headers.get("location")
await response.body?.cancel()
if (!location) throw new Error("Invocation receipt location is missing")
const receipt = new URL(location, origin)
if (receipt.origin !== origin) throw new Error("Receipt points outside the local actor")
console.log(JSON.stringify({ runId, thread: coordinate.thread, receipt: receipt.href, pollMs }))
for (;;) {
  const result = await fetch(receipt, { headers, signal: deadline })
  if (!result.ok) throw new Error(`Receipt read failed (${result.status})`)
  const value = object(await result.json())
  console.log(JSON.stringify(value))
  if (["completed", "failed", "cancelled"].includes(String(value.status))) {
    if (value.status !== "completed") process.exitCode = 1
    break
  }
  await Bun.sleep(pollMs)
  deadline.throwIfAborted()
}
