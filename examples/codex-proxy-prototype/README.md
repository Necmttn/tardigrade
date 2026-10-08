# Codex proxy prototype

This experiment checks whether a Responses proxy can connect a Tardigrade actor to Codex device authentication. It also contains a Cron Trigger and queue example for delivery to an existing Tardigrade thread. The proxy runs in Bun beside Celld. It does not run inside a Worker.

The prototype remains on branch `prototype/codex-proxy`. It is not production code. The proxy uses Bun without additional packages. Device credentials remain in memory. Device mode requires authentication after each restart. Set `CODEX_AUTH_SOURCE=cache` to read the existing `~/.codex/auth.json` instead. Cache mode does not modify credentials or renew tokens; Codex owns renewal.

## Run the local fixture

Run these commands from the worktree root:

```sh
bun run examples/codex-proxy-prototype/src/main.ts --demo --inspect
```

This command prints the converted request and a synthetic SSE response. It does not contact OpenAI. To serve the same fixture over HTTP, omit `--inspect`:

```sh
bun run examples/codex-proxy-prototype/src/main.ts --demo
```

In another terminal:

```sh
curl -N http://127.0.0.1:8789/v1/responses \
  -H 'Authorization: Bearer prototype-demo-key' \
  -H 'Content-Type: application/json' \
  -d '{"model":"prototype-fixture","stream":true,"input":"Check the connection."}'
```

## Run device authentication

```sh
export PROXY_API_KEY="$(openssl rand -hex 32)"
bun run examples/codex-proxy-prototype/src/main.ts
```

Open the printed authentication URL. Enter the device code there. Keep the proxy running. Use the same `PROXY_API_KEY` in your Tardigrade process. Choose a model that your account can access. The demo model does not exist upstream.

OpenAI documents device authentication for remote Codex use. The local actor completes live model requests through this connection. See [OpenAI authentication](https://learn.chatgpt.com/docs/auth).

## Connect Tardigrade

Use the OpenAI Responses provider module in your Worker:

```ts
import { providerLayer } from "tardie/model/providers/openai"
```

Pass this provider layer to `workerModelServices({ model: { providerLayer }, scope: modelScopeFrom(modelLock) })`. Add the following provider connection to your model configuration and model lock:

```json
{
  "codex-proxy": {
    "protocol": "openai-responses",
    "baseUrl": "http://127.0.0.1:8789/v1",
    "env": ["PROXY_API_KEY"]
  }
}
```

This is a provider fragment, not a complete lock file. The lock also needs the selected model and its context metadata. Select that model with provider `codex-proxy`. Supply the proxy key to Celld through `CELLD_VAR_PROXY_API_KEY`. The URL must be reachable from each Celld node. A loopback URL requires the proxy on the same host and network namespace.

Set the model option `store: false`. The proxy accepts streaming Responses requests only. It converts leading system messages to instructions. It preserves tool definitions, tool results, reasoning items, and the upstream SSE bytes. It rejects unknown fields. Codex rejects `max_output_tokens`. The default `PROXY_OUTPUT_LIMIT_POLICY=reject` refuses requests with this field. Set `PROXY_OUTPUT_LIMIT_POLICY=omit-with-notice` for this experiment. This mode removes the field and returns `x-codex-output-limit: requested=<value>; enforcement=none`. The browser displays this limitation. The Codex backend does not enforce the requested output limit.

The response header `x-codex-prototype-policy` reports the conversion. Authenticated `GET /healthz` reports limits. The proxy does not guarantee upstream idempotency. Tardigrade must continue to own tool execution and history.

## Configuration

The source exports `PROXY_DEFAULTS` and `AUTH_DEFAULTS`. The command accepts these environment overrides:

| Variable | Default | Effect |
| --- | --- | --- |
| `CODEX_AUTH_SOURCE` | `device` | Device login or existing Codex cache |
| `PROXY_OUTPUT_LIMIT_POLICY` | `reject` | Reject output limits or omit them with a response notice |
| `PROXY_HOST` | `127.0.0.1` | Listening address |
| `PROXY_PORT` | `8789` | Listening port |
| `PROXY_REQUEST_MS` | `180000` | Upstream request deadline, including stream consumption |
| `PROXY_MAX_BODY_BYTES` | `1048576` | Request body limit |
| `CODEX_UPSTREAM` | Codex Responses URL | Upstream endpoint |
| `CODEX_USER_AGENT` | Value in `PROXY_DEFAULTS` | Upstream user agent |
| `CODEX_AUTH_ISSUER` | `https://auth.openai.com` | Authentication issuer |
| `CODEX_CLIENT_ID` | Public Codex client ID | OAuth client |
| `AUTH_REQUEST_MS` | `30000` | Authentication request deadline |
| `AUTH_LOGIN_MS` | `900000` | Device authentication deadline |
| `AUTH_POLL_MS` | `5000` | Minimum polling interval; the issuer can require a longer interval |
| `AUTH_REFRESH_MARGIN_MS` | `60000` | Token renewal margin |

The proxy disables the Bun idle timeout. The upstream deadline limits model streaming. It supports one account per process. Concurrent requests share a token renewal operation. Multiple processes do not share tokens or coordinate renewal. Bind the live prototype to a private interface; use TLS if requests cross an untrusted network.

## Scheduled jobs and queues

Tardigrade already has durable alarms. See [the alarm actor](../alarm/actor.ts). Its alarm tool accepts `{ wakeAt, note }` and can send a message when the alarm fires. This supports an individual agent's future work. A recurring schedule requires application logic to calculate and record the next occurrence.

Celld provides [Cron Triggers](https://github.com/denoland/celld/blob/main/docs/services/cron-triggers.md), [Queues](https://github.com/denoland/celld/blob/main/docs/services/queues.md), and [Workflows](https://github.com/denoland/celld/blob/main/docs/services/workflows.md). Cron uses UTC and has one-minute resolution. After downtime, Celld runs one missed occurrence and skips the remaining missed occurrences. Applications that need every interval must record and recover them. Cron retry state resides in memory.

`src/jobs-worker.ts` and `jobs.celld.jsonc` show this path:

```text
Cron Trigger -> JOBS queue -> Tardigrade message method -> actor -> Codex proxy
```

The example schedules a message every five minutes. Change `triggers.crons` to set another schedule. `0 1 * * *` means 09:00 each day in Asia/Makassar. Change `JOB_TEXT` and `TARDIGRADE_MESSAGE_URL` for your actor. Supply `TARDIGRADE_TOKEN` through the Celld node environment. The target actor and thread must exist before delivery.

Merge the `scheduled` and `queue` handlers into the active Tardigrade Worker. Preserve its existing `fetch` handler and Durable Object exports. Merge the manifest fields into the active deployment configuration. The standalone sample documents the handlers; it is not a second deployment to the same fleet bucket. Celld service-binding targets do not run their own Cron Triggers.

The queue acknowledges a job after Tardigrade returns `202 Accepted`. This confirms delivery, not successful model execution. To track completion, retain the receipt and poll its location. Use a Workflow when subsequent steps depend on completion. The example does not implement completion tracking.

The job key combines the cron expression and scheduled time. Queue redelivery uses that same key as the Tardigrade `Idempotency-Key`. Queues deliver at least once and do not guarantee order. The manifest sets retry, concurrency, and dead-letter behavior explicitly. Celld retains queue messages for four days; its current implementation does not expose a retention override.

## Local Celld and MCPHub experiment

The complete experiment has this path:

```text
ask.ts -> Tardigrade actor on celld dev -> Codex Responses proxy
                     |
                     +-> native tool -> local MCP bridge -> MCPHub -> Appllama
```

The actor exposes `appllama_get_credits` and `appllama_list_flows`. The first call is free. The second spends one Appllama credit. The bridge rejects other tool names. MCP credentials remain in the Bun bridge. The Worker receives only a local proxy key.

The bridge reads the `mcphub` entry in `~/.codex/config.toml`. It supports static headers, an environment bearer token, and the configured `http_headers_helper`. It executes that trusted helper without printing its output. It initializes an MCP session, discovers the selected tools, and accepts JSON or SSE replies. It does not inherit this assistant session's approval controls. Use the explicit two-tool allowlist as the boundary for this experiment.

Install Bun 1.4 or later, Celld, and esbuild before starting. Put Celld and esbuild on `PATH`. Install the repository dependencies with `bun install --frozen-lockfile` from the worktree root. The Worker imports the repository workspace packages. [Celld local development](https://github.com/denoland/celld/blob/main/docs/README.md#develop-an-application-locally) uses a local SQLite object store. It needs no Docker daemon or cloud bucket.

From the worktree root, set your model ID and its context window. Then run:

```sh
export CODEX_MODEL=your-model-id
export CODEX_CONTEXT_TOKENS=your-model-context-window
export PROXY_OUTPUT_LIMIT_POLICY=omit-with-notice
bun run examples/codex-proxy-prototype/src/local.ts
```

The launcher generates ignored configuration and random local access keys. It stores the keys in `celld/.dev.vars` with mode `0600`. It starts the proxy and `celld dev`. Complete the printed device authentication procedure. Wait for both listeners before continuing. In another terminal, run:

```sh
bun run examples/codex-proxy-prototype/src/ask.ts
```

The request asks the actor to read the available credits and onboarding categories. The script creates a thread, submits the message, and polls the invocation receipt. It prints the final result or failure. `DEMO_RUN_ID` supplies a stable key for a repeated submission. Without it, each command creates a new run. `DEMO_PROMPT` overrides the request text. Stop the launcher with Ctrl-C to stop its processes. Celld retains local actor state under `celld/.celld/dev`.

To use the existing React chat interface, start a second process from the worktree root:

```sh
bun run examples/codex-proxy-prototype/src/ui.ts
```

Open `http://127.0.0.1:5173`. The Vite server forwards API requests to Celld and adds the actor key on the server. The browser receives no provider or MCP credentials. `UI_PORT` overrides port 5173. `CELLD_DEV_PORT` must match the actor listener. This example supports text messages and tool results; attachments are unavailable. The browser polls completed events every 1000 ms because the local live stream fails. Set `UI_POLL_MS` to change this interval. Responses appear when complete. The shared React example retains streaming unless `VITE_EVENT_POLL_MS` is positive.

| Variable | Default | Effect |
| --- | --- | --- |
| `CELLD_DEV_PORT` | `9876` | Local actor port |
| `PROXY_PORT` | `8789` | Local model and MCP bridge port |
| `TOOL_REQUEST_MS` | `120000` | Actor tool request deadline |
| `CODEX_CONFIG_FILE` | `~/.codex/config.toml` | MCP connection configuration |
| `MCP_SERVER_NAME` | `mcphub` | Configured MCP connection |
| `MCP_REQUEST_MS` | `30000` | Each MCP HTTP request deadline |
| `MCP_MAX_PAGES` | `20` | Discovery page limit; exceeding it returns an error |
| `ASK_WAIT_MS` | `300000` | Submission and receipt polling deadline |
| `ASK_POLL_MS` | `1000` | Receipt polling interval |

The MCP protocol default is exported in `MCP_DEFAULTS`. The server negotiates the session version. MCPHub tool names must normalize to the two allowlisted names. Live discovery from the Bun process returns both selected tools. The actor uses the same streaming proxy restrictions described above.

## Verification boundary

Direct handler checks pass for key isolation, system conversion, tool definitions, tool results, SSE bytes, body limits, and rate-limit status. Authentication fixtures pass for pending device codes, token exchange, concurrent renewal, and account retention. Job fixtures pass for stable occurrence keys, acknowledgement after delivery, and retry after failure. Strict TypeScript checking passes with cached compiler and Bun declarations.

The `--demo --inspect` command works without a listener. Live verification completes a model request through the proxy and Celld. The browser sends a message and displays its completed response. Production use also needs durable encrypted credentials and coordination between processes.

MCP fixtures pass for session initialization, concurrent discovery, session headers, pagination, the tool allowlist, split SSE frames, and the discovery limit. Celld 0.6.0 serves the actor locally with Bun 1.4.2. The browser displays the existing chat interface and an allocated thread. Live MCP discovery from the local process returns both allowlisted Appllama tools. The running experiment uses `gpt-6-astra` with a configured prototype context budget of 32768 tokens; this setting is not a claim about the model's maximum context window.

The browser request also completes `appllama_get_credits` through Celld, the local bridge, and MCPHub. The full path to `appllama_list_flows` remains untested. The experiment exposes only the two selected Appllama tools.

The Cloudflare host supplies application dependencies during cold rest checks. Two regression checks pass, including a component with a required service. Prototype and browser TypeScript checks pass.
