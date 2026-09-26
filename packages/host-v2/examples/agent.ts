import { Effect } from "effect"
import { agentOutcome, type AgentInput } from "@clavia/tardigrade-agent-v2"
import { agentHost, memoryJournal } from "../src"
import { services } from "./services"
import { assistant } from "./assistant"

const journal = memoryJournal<AgentInput>()
const host = agentHost(assistant, journal, { maxEffects: 20 })
const result = await Effect.runPromise(host.run([
  { type: "MessageReceived", turnId: "turn:1", message: "What is 2 + 3?" },
]).pipe(Effect.provide(services)))
console.log(JSON.stringify({ ...result, execution: result.status, ...agentOutcome(result.events, result.view) }, null, 2))
