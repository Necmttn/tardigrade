import { fileURLToPath } from "node:url"
import { Config, Console, Effect, Layer } from "effect"
import { Argument, Command } from "effect/unstable/cli"
import { FetchHttpClient, HttpRouter } from "effect/unstable/http"
import { BunHttpServer, BunRuntime, BunServices } from "@effect/platform-bun"
import { RuntimeError } from "tardie/core"
import { Codex } from "./auth"
import { ask, DEFAULT_WAIT_MS } from "./ask"
import { start } from "./local"
import { routes, DEFAULT_BODY_BYTES } from "./proxy"

export const DEFAULT_PROXY_PORT = 8789
const directory = fileURLToPath(new URL(".", import.meta.url))
const serve = (key: string) => Effect.gen(function* () {
  const port = yield* Config.Int("PROXY_PORT").pipe(Config.withDefault(DEFAULT_PROXY_PORT))
  const maxRequestBodySize = yield* Config.Int("PROXY_BODY_BYTES").pipe(Config.withDefault(DEFAULT_BODY_BYTES))
  yield* Console.log("Codex does not enforce max_output_tokens. The proxy removes this field.")
  const server = HttpRouter.serve(routes(key)).pipe(
    Layer.provideMerge(Codex.layer),
    Layer.provideMerge(BunHttpServer.layer({ hostname: "127.0.0.1", port, idleTimeout: 0, maxRequestBodySize }))
  )
  return yield* Layer.launch(server)
})
const startCommand = Command.make("start", {}, () => Effect.scoped(Effect.gen(function* () {
  const { key, child } = yield* start(directory)
  yield* Effect.raceFirst(serve(key), child.exitCode.pipe(Effect.flatMap(code => code === 0 ? Effect.void : Effect.fail(new RuntimeError(`Celld exits with ${code}`)))))
})))
const serveCommand = Command.make("serve", {}, () => Effect.flatMap(Config.String("PROXY_API_KEY"), serve))
const askCommand = Command.make("ask", {
  text: Argument.String("text").pipe(Argument.withDefault("What time is it? Use the tool."))
}, ({ text }) => Effect.gen(function* () {
  const waitMs = yield* Config.Int("ASK_WAIT_MS").pipe(Config.withDefault(DEFAULT_WAIT_MS))
  yield* ask(directory, text).pipe(Effect.timeout(waitMs))
}))
const command = Command.make("codex-proxy").pipe(Command.withSubcommands([startCommand, serveCommand, askCommand]))

Command.run(command, { version: "0.0.1" }).pipe(
  Effect.provide(Layer.merge(BunServices.layer, FetchHttpClient.layer)),
  BunRuntime.runMain
)
