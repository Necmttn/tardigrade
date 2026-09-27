# Experimental platforms

Platform adapters supply persistent journals to the shared actor host. Bun uses a SQLite file. Cloudflare uses the SQLite database owned by a Durable Object. Each journal selects an actor identity and rejects an append whose expected event count differs from storage.

## Threads

`createBunHost` runs an actor definition across instances and threads. `layersFor(coordinate, runtime)` supplies the definition's inferred service requirements. Each instance has a supervisor actor whose durable `threads` atom records allocation and registration. The host provides `ThreadProvisioner` to open the requested thread. Named roots are scoped by instance; named children are scoped by parent.

```ts
import { createBunHost } from "@clavia/tardigrade-experimental-platform/bun"
import { createActor } from "@clavia/tardigrade-experimental-agent"
import { assistantServices } from "@clavia/tardigrade-experimental-agent/services/runtime"

const host = await createBunHost({
  actor: createActor,
  storage: "./data",
  layersFor: (_coordinate, runtime) => assistantServices(runtime, {
    services: modelServices,
    maxChildDepth: 1,
  }, 0),
})

try {
  const main = await host.allocateRootThread({ instance: "arjun", name: "main" })
  const child = await host.allocateChildThread({ parent: main.coordinate, name: "researcher" })
  const receipt = await main.methods.message({ text: "Hello" }, { key: "hello-1" })
  console.log(child.coordinate, receipt)
} finally {
  await host.close()
}
```

`modelServices` is the application's model and model-lock layer. The host owns all opened actors and journal connections. Instance database filenames encode `[actor, instance]`; each thread has its own sibling database containing separate domain-event and invocation logs. Omitted names use UUIDs, or a caller-supplied `generateName`. A generated-name collision is reported to the caller.

Invocation keys are scoped to a thread. Retrying the same method and JSON arguments returns its saved receipt; reusing a key with different input fails. Receipts report `pending`, `completed`, or `failed`. Completion means the action promise resolved, and does not wait for background tasks or provide a typed domain result. An interrupted request with no recorded settlement remains pending and is not automatically reexecuted. `thread.invocation(key)` reads its current receipt.

Allocation and invocation admission are serialized within a host. Journal compare-and-append rejects stale writers across hosts; this implementation does not coordinate concurrent owners of the same thread. Provisioning may be repeated after interruption and must be idempotent. The agent package's subagent tool still uses its local task runtime; calling `allocateChildThread` creates a supervised thread explicitly. Cloudflare thread placement requires an additional adapter.

## Journals

```ts
import { bunJournal } from "@clavia/tardigrade-experimental-platform/bun"
import type { Event } from "@clavia/tardigrade-experimental-agent/event"

const journal = bunJournal<Event>({ filename: "./tardie.sqlite", actor: "assistant" })
const actor = await createActor({ ...runtimeOptions, journal })
try {
  await actor.message({ text: "Hello" })
} finally {
  await actor.close()
  journal.close()
}
```

Inside a SQLite Durable Object, supply `cloudflareJournal<Event>(ctx.storage, ctx.id.toString())` through the same `journal` option. Enable `nodejs_compat` for the core's Node utilities. The Durable Object owns its storage lifetime. Bun callers own their journal connection and close it after the actor.

The host validates the next event prefix, commits it, and publishes the resulting state. Effect requests commit before execution; each result batch commits atomically. A journal failure stops further admissions until the actor is reopened. `onEvent` observes committed events. Supplying both `events` and `journal` is rejected.

Opening an actor replays its journal. Requested effects with no settlement remain visible through `snapshot().pending()`; they are not automatically retried because their external outcome may be unknown. Background fibers still depend on a live process. Durable alarm wakeups, interrupted-effect recovery, remote delivery, and platform deployment entrypoints are outside these journal adapters.

## HTTP

```ts
import { serve } from "@clavia/tardigrade-experimental-platform/bun"

const server = await serve(host, { port: 4242 })
console.log(server.url.href)
// Close the server before closing its host.
await server.close()
```

The adapter uses Effect's `HttpRouter` and `BunHttpServer`. `POST /v1/actors/:instance/threads` accepts `{ "name": "main" }`, or a `parent` thread ID to allocate a child. `POST /v1/actors/:instance/threads/:thread/methods/:method` accepts the method's single JSON input and requires `Idempotency-Key`. It returns a receipt with status 202 and a `Location` for `GET /v1/actors/:instance/threads/:thread/invocations/:key`. The POST waits for the action promise; this adapter does not detach invocation execution from the request. A conflicting key returns 409, malformed JSON or a missing key returns 400, and missing resources return 404.

`DEFAULT_SERVE_OPTIONS` exports the defaults: loopback hostname, port 4242, and no idle timeout. Each is overridable through `serve` options. This minimal adapter has no authentication or streaming endpoint. Closing the server leaves the host open.
