# Thread canvas

Thread canvas displays Tardigrade threads and their parent relationships. Foldkit owns the model, messages, update function, commands, subscriptions, and view. SVG draws the connections. HTML buttons provide thread selection. Nodes outside the visible area are not rendered.

## Run

Use Bun 1.4.2 or later. Run these commands from the repository root:

```sh
bun install --frozen-lockfile
bun run --cwd apps/canvas dev --port 5174
```

Open http://127.0.0.1:5174. Demo mode provides 256 deterministic threads across 16 root workflows. All demo events are simulated. Click a node to open its conversation. The panel displays user messages and completed assistant responses. Select Events for the event sequence. Open child links and the parent link move between related threads. Close thread returns to the canvas on mobile. Use the state filter or search to find a thread. Enter a thread ID in search and press Enter, or select Jump to thread. An exact ID takes priority over the state filter. A unique name match also works. Select a search result when several threads match. Search results remain available on mobile. A jump clears the filters, centers the thread, and displays its events. Center thread returns to the selected node after moving through the graph. Drag the graph to move it. Scroll to change the scale. Select Fit to display the complete graph. The graph also accepts arrow keys, plus, minus, and F when focused.

## Live records

Live mode reads the existing research chat server through the Vite proxy. The default server address is http://127.0.0.1:4342. Start a server separately, then select Live. A different server address is supported:

```sh
CANVAS_API_URL=http://127.0.0.1:4342 bun run --cwd apps/canvas dev --port 5174
```

Settings exposes the actor identifier, polling interval, event limit, and request timeout. Select Apply and refresh after an edit. Defaults are exported from `src/data.ts`. Live mode polls the thread list every five seconds. The inspector requests the first 100 events of the selected thread by default and reports the returned count. It does not request all events for every thread. A failed request leaves a visible error. A failed thread refresh preserves the previous graph. Responses from an earlier source or actor are ignored.

The adapter reads `GET /v1/actors/:actor/threads` and `GET /v1/actors/:actor/threads/:thread/events`. It retains event types, sequence numbers, timestamps, and string tool, method, or model identifiers. It retains user text from MessageReceived and assistant output from TurnCompleted. It discards request bodies, headers, model continuation data, and reasoning before storing events in the view model. It provides no write commands, server authentication interface, or OpenTelemetry receiver. Live records describe one actor. Demo mode illustrates the larger canvas interaction.

## Dependencies and checks

Foldkit 0.167.0 requires Effect 4.0.0 and `@effect/platform-browser` 4.0.0. The server packages retain their pinned Effect release candidate. The canvas uses Bun's `installConfig.hoistingLimits` setting to keep its dependency tree inside this workspace. See [Bun workspace installation](https://bun.sh/docs/pm/workspaces#self-contained-workspaces) and [Foldkit](https://foldkit.dev/).

```sh
bun run --cwd apps/canvas test
bun run --cwd apps/canvas typecheck
bun run --cwd apps/canvas build
```

The repository gate includes these checks and Effect lint. Tests cover 1,024 nodes, cycles, missing parents, deep branches, cursor-centered zoom, filters, event payload reduction, request failures, and late responses. The production build produces static files. Its host must route `/v1` to the server; the Vite development proxy is not part of the build.
