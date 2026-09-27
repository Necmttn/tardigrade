import { RuntimeError } from "@clavia/tardigrade-experimental-core"
import { Cause, Deferred, Effect, Exit, Layer } from "effect"
import { AlarmScheduler, AgentRunner, Workspace, memoryWorkspace, TaskExecution, TaskRuntime, type TaskDecision } from "@clavia/tardigrade-experimental-packages"
import type { ActorRuntime, Recorded } from "@clavia/tardigrade-experimental-core"
import { createActor } from "../agent"
import type { Event } from "../event"
import { ModelLock } from "./model-lock"
import { Model } from "./model"
import { alarmServices } from "./alarms"

export interface AssistantContext {
  readonly depth: number
  readonly taskId: string | undefined
}

export interface AssistantOptions {
  readonly services: Layer.Layer<Model | ModelLock, Error> | ((context: AssistantContext) => Layer.Layer<Model | ModelLock, Error>)
  readonly maxChildDepth: number
  readonly onEvent?: (event: Recorded<Event>, depth: number) => void
}

// assistantServices connects package tools and scoped child actors to the actor store.
export function assistantServices(host: ActorRuntime<Event>, options: AssistantOptions, depth: number, parentTask?: typeof TaskExecution.Service): Layer.Layer<Model | ModelLock | AlarmScheduler | AgentRunner | Workspace | TaskRuntime, Error> {
  const toolServices = Layer.unwrap(Effect.sync(() => {
    const replies = new Map<string, { readonly kind: string; readonly deferred: Deferred.Deferred<TaskDecision> }>()
    const key = (taskId: string, requestId: string) => JSON.stringify([taskId, requestId])
    const runtime: typeof TaskRuntime.Service = {
      start: (call, run) => Effect.gen(function* () {
        const taskId = `task:${call.callId}`
        yield* host.record({ type: "TaskStarted", taskId, callId: call.callId, name: call.name })
        const execution: typeof TaskExecution.Service = {
          taskId,
          notify: message => host.send([{ type: "MessageReceived", kind: "message", turnId: `${taskId}:notice:${crypto.randomUUID()}`, text: JSON.stringify({ taskId, message }) }]),
          request: request => Effect.gen(function* () {
            const id = key(taskId, request.requestId)
            if (replies.has(id)) return yield* Effect.fail(new RuntimeError("Task request already pending"))
            const deferred = Deferred.makeUnsafe<TaskDecision>()
            replies.set(id, { kind: request.kind, deferred })
            return yield* Effect.gen(function* () {
              yield* host.send([{ type: "MessageReceived", kind: "request", taskId, request }])
              return yield* Deferred.await(deferred)
            }).pipe(Effect.ensuring(Effect.sync(() => { replies.delete(id) })))
          }),
        }
        yield* host.fork(taskId, run.pipe(
          Effect.provideService(TaskExecution, execution),
          Effect.exit,
          Effect.flatMap(exit => {
            const output = Exit.isSuccess(exit) ? JSON.stringify(exit.value) ?? "null" : ""
            const error = Exit.isFailure(exit) ? Cause.pretty(exit.cause) : null
            return host.send([
              { type: "TaskSettled", taskId, output, error },
            ])
          }),
        ))
        return { taskId }
      }),
      reply: (taskId, requestId, decision) => Effect.gen(function* () {
        const pending = replies.get(key(taskId, requestId))
        if (!pending || pending.kind !== "budget") return yield* Effect.fail(new RuntimeError("No matching pending budget request"))
        if (decision.allowed && (!Number.isSafeInteger(decision.amount) || decision.amount! < 1)) return yield* Effect.fail(new RuntimeError("Budget grant must be a positive safe integer"))
        yield* host.record({ type: "MessageReceived", kind: "reply", taskId, requestId, decision })
        yield* Deferred.succeed(pending.deferred, decision)
        replies.delete(key(taskId, requestId))
      }),
      cancel: host.cancel,
    }
    const children = Layer.succeed(AgentRunner, {
      run: (message, task) => Effect.gen(function* () {
        if (depth >= options.maxChildDepth) return yield* Effect.fail(new RuntimeError(`Child depth limit reached: ${options.maxChildDepth}`))
        return yield* Effect.acquireUseRelease(
          Effect.tryPromise({ try: () => createActor(assistantRuntime(options, depth + 1, task)), catch: RuntimeError.from }),
          child => Effect.tryPromise({ try: async signal => {
            const stop = () => { void child.close() }
            signal.addEventListener("abort", stop, { once: true })
            try {
              await child.message({ text: message })
              await child.wait()
              const reply = child.snapshot().events.findLast(event => event.type === "TurnSettled")
              if (!reply || reply.type !== "TurnSettled") throw new RuntimeError("Child finished without an answer")
              if (reply.outcome !== "completed") throw new RuntimeError(reply.reason)
              return { answer: reply.output }
            } finally { signal.removeEventListener("abort", stop) }
          }, catch: RuntimeError.from }),
          child => Effect.promise(() => child.close()),
        )
      }),
    })
    return Layer.mergeAll(memoryWorkspace, children, Layer.succeed(TaskRuntime, runtime), alarmServices(host))
  }))
  const services = typeof options.services === "function" ? options.services({ depth, taskId: parentTask?.taskId }) : options.services
  return Layer.merge(services, toolServices)
}

// assistantRuntime configures services and observation for one level of child actors.
export function assistantRuntime(options: AssistantOptions, depth = 0, parentTask?: typeof TaskExecution.Service) {
  if (!Number.isSafeInteger(options.maxChildDepth) || options.maxChildDepth < 0) throw new RuntimeError("maxChildDepth must be a nonnegative integer")
  return {
    services: (host: ActorRuntime<Event>) => assistantServices(host, options, depth, parentTask),
    onEvent: (event: Recorded<Event>) => options.onEvent?.(event, depth),
  }
}
