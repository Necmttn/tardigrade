# Codex provider

Sign in with your ChatGPT account and make a single Codex request through Tardigrade's model interface. This example runs in Bun. For an interactive browser chat with tools and child agents, see [react-rlm-chat](../react-rlm-chat/README.md#run-with-codex-on-bun).

## Run

From the repository root:

```sh
bun install
cd examples/codex-provider
bun main.ts login
bun main.ts models
CODEX_MODEL=<id-from-models> bun main.ts ask "Say hello."
```

`login` saves private credentials to `.codex-credentials.json`. `models` lists the models available to your account. `ask` prints a response and exits, renewing and saving credentials when needed. Set `CODEX_CREDENTIALS_FILE` to use a different credential file.

## Use in your application

Create a shared credentials service with a callback that saves renewed tokens, then pass it to the provider:

```ts
import { createProviderLayer } from "tardie/model/providers/codex"
import { credentialsFromTokens } from "tardie/model/providers/codex-auth"

const auth = yield* credentialsFromTokens(tokens, {}, persistRotatedTokens)
const layer = createProviderLayer(auth)({
  provider: "codex",
  client: {},
  model: { model: "<available-model-id>" }
})
```

The layer supports `LanguageModel.generateText`, `streamText`, and `generateObject`. Share `auth` across model bindings for the same account so concurrent requests coordinate token renewal. See [credentials.ts](credentials.ts) for file persistence and [main.ts](main.ts) for login and model discovery.

Codex does not enforce output token limits. The provider warns and omits `max_output_tokens` by default. Use `createProviderLayer(auth, { outputLimit: "reject" })` to reject requests that specify this limit.
