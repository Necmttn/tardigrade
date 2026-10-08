import { connect } from "@clavia/tardigrade-client"
import definition from "./actor"

const vars = await Bun.file(new URL("celld/.dev.vars", import.meta.url)).text()
const token = vars.split("\n").find((line) => line.startsWith("TARDIGRADE_TOKEN="))?.slice("TARDIGRADE_TOKEN=".length)
if (!token) throw new Error("Run local.ts first")
const client = connect({
  url: `http://127.0.0.1:${process.env.CELLD_DEV_PORT ?? 9876}`,
  actor: definition,
  token
})
const thread = await client.allocateRootThread({ instance: "demo" })
console.log(await thread.methods.message({ text: process.argv[2] ?? "What time is it? Use the tool." }, { key: crypto.randomUUID() }))
