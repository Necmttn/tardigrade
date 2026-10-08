# Codex proxy

A local Celld actor uses Codex device authentication through a Bun Responses proxy. The actor has a current-time tool.

```text
ask command → Celld actor → Responses proxy → Codex
              └→ current_time
```

## Run

Install Bun 1.4 or later, Celld, and esbuild. Put Celld and esbuild on PATH. Install the repository dependencies with `bun install --frozen-lockfile`.

Set `model_id` and `contextWindowTokens` in `celld/models.lock.json` for a model available to your account. The supplied context value is an example. From the repository root:

```sh
bun examples/codex-proxy/main.ts start
```

Open the printed authentication URL and enter the device code. Wait for the proxy and Celld listeners. In another terminal:

```sh
bun examples/codex-proxy/main.ts ask
bun examples/codex-proxy/main.ts ask "Say hello."
```

The launcher writes local access keys to ignored `celld/.dev.vars`. Credentials stay in the CLI process. Stop the command with Ctrl-C. Celld retains actor state under `celld/.celld/`.

## Configuration

`CELLD_DEV_PORT` sets the actor port (default `9876`). `PROXY_REQUEST_MS` sets the model request deadline (default `180000`). `PROXY_BODY_BYTES` sets the request body limit (default `1048576`). To change the proxy port, set `PROXY_PORT` and update the provider URL in `celld/models.lock.json`.

`ASK_WAIT_MS` sets the message deadline (default `180000`). `ASK_POLL_MS` sets the result check interval (default `1000`).

Authentication defaults are exported in `auth.ts`. `Codex` is an Effect service with a live layer. HTTP uses `HttpClient` and `HttpRouter`; files use `FileSystem`; time uses `Clock`; Celld uses a scoped `ChildProcessSpawner`. `main.ts` supplies the Bun runtime layers.

## Limits

The proxy accepts streaming Responses requests with an input array. It converts leading system messages to instructions and sets `store=false`. Tool calls, tool results, and reasoning items pass through unchanged. Codex rejects `max_output_tokens`; the proxy removes it and reports `x-codex-output-limit: enforcement=none`. The startup message states this limitation.

This example supports one account and local listeners. Device authentication is required after each restart. The proxy renews tokens while running. It provides no persistent credential storage or deployment setup.

## Checks

```sh
bun test examples/codex-proxy/proxy.test.ts
bun --bun node_modules/.bin/tsc --noEmit -p examples/codex-proxy/tsconfig.json
bun run gate
```
