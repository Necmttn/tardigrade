import { mkdirSync } from "node:fs"
import { dirname } from "node:path"
import { Effect } from "effect"
import { AgentInput, agentOutcome } from "@clavia/tardigrade-agent-v2"
import { agentHost } from "../src"
import { sqliteJournal } from "../src/sqlite"
import { assistant } from "./assistant"
import { liveServices } from "./openrouter"

const [path = ".tardigrade/agent-v2.sqlite", stream = "assistant", message] = process.argv.slice(2)
mkdirSync(dirname(path), { recursive: true })
const journal = sqliteJournal({ path, stream, schema: AgentInput })
try {
  const existing = await Effect.runPromise(journal.read())
  const incoming: readonly AgentInput[] = message !== undefined || existing.length === 0
    ? [{ type: "MessageReceived", turnId: crypto.randomUUID(), message: message ?? "What is 2 + 3?" }]
    : []
  const host = agentHost(assistant, journal, { maxEffects: 20 })
  const services = await Effect.runPromise(liveServices)
  const result = await Effect.runPromise(host.run(incoming).pipe(Effect.provide(services)))
  console.log(JSON.stringify({ path, stream, ...result, execution: result.status, ...agentOutcome(result.events, result.view) }, null, 2))
} finally {
  journal.close()
}
