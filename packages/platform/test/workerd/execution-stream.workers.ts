import { env } from "cloudflare:workers"
import { runInDurableObject } from "cloudflare:test"
import { expect, test } from "vitest"
import { Context, Deferred, Effect, Schema, Stream } from "effect"
import { act, actorMethod, defineActor, durableAtom, EffectExecution, effectAtom, event, type ExecutionUpdate } from "@clavia/tardigrade-core"
import { createCloudflareHost } from "../../src/cloudflare"
import type { TestPromiseResolver } from "./fixture.worker"

const namespace = (env as unknown as { PROMISE_RESOLVER: DurableObjectNamespace<TestPromiseResolver> }).PROMISE_RESOLVER

test("Cloudflare thread execution streams live act updates without journal entries", async () => {
  await runInDurableObject(namespace.getByName("execution-stream"), async (_instance, state) => {
    const Started = event({ type: "Started" })
    const Job = act({ name: "workerd.execution-stream", input: Schema.String, success: Schema.String, failure: Schema.String })
    const running = durableAtom({ name: "running", input: Started, schema: Schema.Boolean, initial: false, reduce: () => true })
    const actor = defineActor("execution-stream", Effect.sync(() => {
      const request = Job.request({ tag: "job", input: "payload" })
      return {
        schema: Started,
        atom: effectAtom(get => ({ view: get(request.result), events: {}, acts: get(running) ? { job: request } : {} })),
        methods: {
          start: actorMethod({ inputSchema: Schema.Null, outputSchema: Schema.String, onReceive: Started.from(() => ({})), result: (_, get) => {
            const result = get(request.result)
            if (result.status !== "fulfilled") return undefined
            return { status: "completed" as const, output: result.value }
          } }),
        },
      }
    }))
    const release = Deferred.makeUnsafe<void>()
    const host = createCloudflareHost({ actor, storage: state.storage, actorContext: Context.pick(), services: () => Job.layer(() => Effect.gen(function* () {
      const execution = yield* EffectExecution
      yield* execution.publish({ type: "tool.progress", message: "running in workerd" })
      yield* Deferred.await(release)
      return "done"
    })) })
    try {
      const thread = await Effect.runPromise(host.allocateRootThread({ instance: "main", name: "root" }))
      const updates = Effect.runPromise(thread.execution.stream.pipe(Stream.take(1), Stream.runCollect))
      await Effect.runPromise(thread.invoke("start", null, { id: "start" }))
      const received = (await updates)[0] as ExecutionUpdate
      expect(received.address).toEqual({ actor: "execution-stream", instance: "main", thread: "root" })
      expect(received.payload).toEqual({ type: "tool.progress", message: "running in workerd" })
      expect(received.ref.tag).toBe("job")
      expect((await Effect.runPromise(thread.records())).some(record => JSON.stringify(record.event).includes("tool.progress"))).toBe(false)
      await Effect.runPromise(Deferred.succeed(release, undefined))
      await Effect.runPromise(thread.wait)
      expect(thread.getState().view).toEqual({ status: "fulfilled", value: "done" })
    } finally {
      await Effect.runPromise(host.close)
    }
  })
})
