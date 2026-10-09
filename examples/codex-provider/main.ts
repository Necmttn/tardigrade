import { Config, Console, Effect, FileSystem, Layer, Schema } from "effect"
import { Argument, Command } from "effect/unstable/cli"
import { FetchHttpClient } from "effect/unstable/http"
import { LanguageModel } from "effect/unstable/ai"
import { BunRuntime, BunServices } from "@effect/platform-bun"
import { createProviderLayer } from "tardie/model/providers/codex"
import { CodexAuthError, credentialsFromTokens, deviceLogin, type Tokens } from "tardie/model/providers/codex-auth"

export const DEFAULT_CREDENTIALS_FILE = ".codex-credentials.json"
const tokensSchema = Schema.Struct({ accessToken: Schema.NonEmptyString, refreshToken: Schema.NonEmptyString, accountId: Schema.NonEmptyString, expiresAt: Schema.Finite })
const credentialFile = Config.String("CODEX_CREDENTIALS_FILE").pipe(Config.withDefault(DEFAULT_CREDENTIALS_FILE))
const save = (file: string, tokens: Tokens) => Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem
  const temporary = `${file}.tmp`
  yield* fs.writeFileString(temporary, JSON.stringify(tokens), { mode: 0o600, flag: "wx" })
  yield* fs.rename(temporary, file)
}).pipe(Effect.mapError(() => new CodexAuthError({ message: "Cannot save Codex credentials" })))
const login = Command.make("login", {}, () => Effect.gen(function* () {
  const tokens = yield* deviceLogin(({ url, code }) => Console.log(`Open ${url} and enter ${code}`))
  yield* save(yield* credentialFile, tokens)
  yield* Console.log("Credentials saved with owner-only access.")
}))
const ask = Command.make("ask", {
  text: Argument.String("text").pipe(Argument.withDefault("Reply with one short greeting."))
}, ({ text }) => Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem
  const file = yield* credentialFile
  const encoded = yield* fs.readFileString(file)
  const tokens = yield* Schema.decodeEffect(Schema.fromJsonString(tokensSchema))(encoded).pipe(
    Effect.mapError(() => new CodexAuthError({ message: "Invalid credential file; run login" }))
  )
  const auth = yield* credentialsFromTokens(tokens, {}, updated => save(file, updated).pipe(Effect.provideService(FileSystem.FileSystem, fs)))
  const model = yield* Config.String("CODEX_MODEL")
  const provider = createProviderLayer(auth)({ provider: "codex", client: {}, model: { model } })
  const response = yield* LanguageModel.generateText({ prompt: text }).pipe(Effect.provide(provider))
  yield* Console.log(response.text)
}))
const command = Command.make("codex-provider").pipe(Command.withSubcommands([login, ask]))
Command.run(command, { version: "0.0.1" }).pipe(
  Effect.provide(Layer.merge(BunServices.layer, FetchHttpClient.layer)),
  BunRuntime.runMain
)
