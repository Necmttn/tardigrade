import { mkdirSync } from "node:fs"
import { dirname } from "node:path"
import { createInterface } from "node:readline"
import { Effect } from "effect"
import { AgentInput, agentOutcome } from "@clavia/tardigrade-agent-v2"
import { agentHost } from "../src"
import { sqliteJournal } from "../src/sqlite"
import { createAssistant } from "./assistant"

const assistant = createAssistant("manual")
import { liveServices } from "./openrouter"

const [path = ".tardigrade/agent-v2.sqlite", stream = "chat"] = process.argv.slice(2)
mkdirSync(dirname(path), { recursive: true })
const journal = sqliteJournal({ path, stream, schema: AgentInput })
let terminal: ReturnType<typeof createInterface> | undefined
let active: AbortController | undefined
let closing = false
try {
  const services = await Effect.runPromise(liveServices)
  const host = agentHost(assistant, journal, { maxEffects: 20 })
  const existing = await Effect.runPromise(journal.read())
  let view = assistant.view(assistant.replay(existing))
  const pending = () => {
    const permission = view.children.permissions.value
    return permission.requests.find(call => permission.requested.includes(call.callId) && !Object.hasOwn(permission.decisions, call.callId))
  }
  const prompt = () => {
    const request = pending()
    if (request) {
      console.log(`\nPermission required: ${request.name}\n${JSON.stringify(request.input, null, 2)}\nRequest: ${request.callId}`)
      terminal?.setPrompt("Allow this call? [y/n] > ")
    } else terminal?.setPrompt("you > ")
    terminal?.prompt()
  }
  console.log(`\nChat · ${stream} · ${existing.length} saved events`)
  console.log("Type a message. /log shows events, /resume continues, /quit exits.\n")
  if (existing.length && !pending()) console.log(`${agentOutcome(existing, assistant.view(assistant.replay(existing))).message}\n`)
  terminal = createInterface({ input: process.stdin, output: process.stdout, prompt: "you > " })
  terminal.on("SIGINT", () => {
    closing = true
    active?.abort()
    terminal?.close()
  })
  prompt()
  for await (const line of terminal) {
    const message = line.trim()
    if (message === "/quit" || message === "/exit") break
    if (!message) { prompt(); continue }
    try {
      if (message === "/log") {
        console.log(JSON.stringify(await Effect.runPromise(journal.read()), null, 2))
      } else {
        const request = pending()
        let incoming: readonly AgentInput[]
        if (message === "/resume") incoming = []
        else if (request) {
          const answer = message.toLowerCase()
          if (!["y", "yes", "n", "no"].includes(answer)) {
            console.log("Please answer y or n, or /quit to leave it pending.")
            prompt()
            continue
          }
          incoming = [assistant.invoke("resolvePermission", {
            callId: request.callId,
            decision: answer === "y" || answer === "yes" ? { allowed: true } : { allowed: false, reason: "Denied by the user in the CLI" },
          })]
        } else incoming = [{ type: "MessageReceived", turnId: crypto.randomUUID(), message }]
        active = new AbortController()
        console.log("\nWorking…")
        const result = await Effect.runPromise(host.run(incoming).pipe(Effect.provide(services)), { signal: active.signal })
        view = result.view
        const outcome = agentOutcome(result.events, result.view)
        if (!pending() || result.status !== "idle") console.log(`\nassistant > ${result.status === "idle" ? outcome.message : result.message}\n`)
      }
    } catch (error) {
      if (!closing) console.error(`\n${error instanceof Error ? error.message : String(error)}\n`)
    } finally {
      active = undefined
    }
    if (closing) break
    prompt()
  }
} finally {
  terminal?.close()
  journal.close()
}
