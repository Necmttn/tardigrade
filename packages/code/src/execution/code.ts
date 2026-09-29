import { PositionedEvent } from "@clavia/tardigrade-core/event"
import { TurnLifecycleSchema } from "./turn-lifecycle"
import { OperationScope } from "@clavia/tardigrade-core/runtime/context"
import { bindTransitionContext, type TransitionRef } from "@clavia/tardigrade-core/transition/transition"
import { Clock, Deferred, Effect, Fiber, Schema } from "effect"
import type { KeyValueStore } from "effect/unstable/persistence"
import { EventLog } from "@clavia/tardigrade-core/log"
import type { Event } from "@clavia/tardigrade-core/log/event"
import { transitionProjection, type TransitionProjection } from "@clavia/tardigrade-core/transition"
import { component, composeComponents, supportsCheckpoint, type Component, type ComponentOutput, type ComponentResult, type ComponentRequirements } from "@clavia/tardigrade-core/actor"
import { CODE_VIEW_ALGEBRA, type CodeComponent, type CodeView } from "../package/definition"
import type { PackageView } from "../package/definition"
import { packageCallPolicyOf, type PackageCallPolicy, type CodePolicy } from "./policy"
import { Sandbox, sandboxParked, sandboxReturned, type Bindings, type SandboxCall } from "../sandbox/service"
import { eventEpochOf, turnHead, turnOf } from "./turns"
import {
  initialTurnLifecycle,
  reduceTurnLifecycle,
  turnTerminalFrom,
  type TurnLifecycleState
} from "./turn-lifecycle"
import {
  BARE_SPILL_NOTE,
  hydrate,
  spill as spillTo,
  spillPointer,
  spillPolicyOf,
  WORKSPACE_SPILL_NOTE,
  type SpillPolicy
} from "../storage/store"
import { callId as callIdOf } from "./ids"
import { executionKeyOf, executionRefOf, packageKeyOf, codeSettled, packageCalled } from "./events"

const canonicalJson = (value: unknown): string | undefined =>
  JSON.stringify(value, (_key, entry: unknown) => {
    if (entry === null || typeof entry !== "object" || Array.isArray(entry)) return entry
    const record = entry as Readonly<Record<string, unknown>>
    return Object.fromEntries(Object.keys(record).sort().map((key) => [key, record[key]]))
  })

const executeRecorded = (
  execId: string,
  code: string,
  spill: SpillPolicy,
  callPolicy: PackageCallPolicy,
  packages: ReadonlyArray<PackageView>,
  turn?: string,
  epoch = 0,
  dispatchedAt?: number,
  executionRef?: TransitionRef
): Effect.Effect<ReadonlyArray<Event>, never, EventLog | KeyValueStore.KeyValueStore> =>
  Effect.gen(function* () {
    const scope = yield* Effect.serviceOption(OperationScope)
    const stamp = { ...(scope._tag === "Some" ? { ownerRef: scope.value } : {}), ...(executionRef === undefined ? {} : { executionRef }), ...(turn === undefined ? {} : { turn, ...(epoch === 0 ? {} : { epoch }) }) }
    const log = yield* EventLog
    const events = yield* log.read
    const shadow = (turnHead(events) as { shadow?: unknown } | undefined)?.shadow === true
    const sandbox = yield* Sandbox
    const context = yield* Effect.context<KeyValueStore.KeyValueStore>()
    let inFlight = 0
    // accepting closes the attempt's request channel before late guest continuations can append (code.properties.test.ts).
    let accepting = true
    yield* Effect.addFinalizer(() => Effect.sync(() => { accepting = false }))
    let bodyDone = false
    let parked = false
    let drifted: string | undefined
    const parkGate = yield* Deferred.make<void>()
    const finishCall = Effect.gen(function* () {
      inFlight--
      if ((parked || bodyDone) && inFlight === 0) {
        accepting = false
        yield* Deferred.succeed(parkGate, undefined)
      }
    })
    const bindings: Record<string, Record<string, SandboxCall>> = {}
    for (const pkg of packages) {
      const methods: Record<string, SandboxCall> = {}
      for (const method of pkg.methods) {
        methods[method] = (args: unknown, ordinal: number) => {
          if (!accepting) return Promise.resolve(sandboxParked)
          const callId = callIdOf(executionKeyOf({ type: "CodeSettled", execId, ...stamp }), ordinal)
          const callStamp = { ...stamp, ordinal }
          const callKey = packageKeyOf({ type: "PackageCalled", callId, ...callStamp })
          inFlight++
          return Effect.runPromiseWith(context)(
            Effect.gen(function* () {
              yield* Effect.yieldNow
              if (!accepting) return { parked: true }
              const events = yield* log.read
              const sent = events.find(
                (e) => e.type === "PackageCalled" && packageKeyOf(e) === callKey
              ) as { name?: unknown; arguments?: unknown } | undefined
              if (sent !== undefined) {
                const askedName = `${pkg.name}.${method}`
                const drift =
                  String(sent.name) !== askedName
                    ? `asked ${askedName} where the log recorded ${String(sent.name)}`
                    : canonicalJson(sent.arguments) !== canonicalJson(args)
                      ? `asked ${askedName} with different arguments than the log recorded`
                      : undefined
                if (drift !== undefined) {
                  drifted = `nondeterministic body: call ${callId} ${drift}. A body must make the same calls in the same order on every attempt; derive every call from the brief, the input, and recorded returns only.`
                  yield* Deferred.succeed(parkGate, undefined)
                  return yield* Effect.never
                }
              }
              const recorded = events.find(
                (e) => e.type === "PackageReturned" && packageKeyOf(e) === callKey
              )
              if (recorded) {
                const r = recorded as { result?: unknown; tmp?: unknown }
                if (r.tmp !== undefined) {
                  const hydrated = yield* Effect.orDie(hydrate(String(r.tmp)))
                  return { parked: false, result: hydrated === undefined ? r.result : JSON.parse(hydrated) }
                }
                return { parked: false, result: r.result }
              }
              if (sent === undefined) {
                const askedAt = yield* Clock.currentTimeMillis
                yield* log.append([
                  packageCalled({ callId, name: `${pkg.name}.${method}`, arguments: args, policy: { call: callPolicy, spill: { spillBytes: spill.spillBytes, previewChars: spill.previewChars, note: spill.note(callKey) }, shadow }, ...callStamp, at: askedAt })
                ])
              }
              parked = true
              return { parked: true }

            }).pipe(
              Effect.ensuring(finishCall),
              Effect.withSpan("package.call", { attributes: { name: `${pkg.name}.${method}`, callId } })
            )
          ).then((outcome) => outcome.parked ? sandboxParked : sandboxReturned(outcome.result))
        }
      }
      bindings[pkg.name] = methods
    }
    const head = turnHead(events) as { text?: unknown; input?: unknown } | undefined
    const fiber = yield* Effect.forkChild(
      sandbox
        .run(
          code,
          { ...bindings, brief: String(head?.text ?? ""), input: head?.input ?? null } as Bindings,
          { at: dispatchedAt ?? 0, seed: execId }
        )
        .pipe(
          Effect.tap(() => { bodyDone = true; return Effect.void }),
          Effect.withSpan("code.run", { attributes: { execId } })
        )
    )
    yield* Effect.race(Fiber.join(fiber), Deferred.await(parkGate))
    if (inFlight > 0) yield* Deferred.await(parkGate)
    accepting = false
    const at = yield* Clock.currentTimeMillis
    if (drifted !== undefined) {
      yield* Fiber.interrupt(fiber)
      return [codeSettled({ execId, error: drifted, ...stamp, at })]
    }
    if (parked) {
      yield* Fiber.interrupt(fiber)
      return []
    }
    const outcome = yield* Fiber.join(fiber)
    const logs = outcome.logs !== undefined && outcome.logs.length > 0 ? { logs: outcome.logs } : {}
    if (outcome.error === undefined) {
      const json = JSON.stringify(outcome.result ?? null)
      if (json.length > spill.spillBytes) {
        const ref = `${executionKeyOf({ type: "CodeSettled", execId, ...stamp })}.result`
        yield* Effect.orDie(spillTo(ref, json))
        return [
          codeSettled({
            execId,
            ...spillPointer(ref, json.length, json.slice(0, spill.previewChars), spill.note),
            ...logs,
            ...stamp,
            at
          })
        ]
      }
      return [codeSettled({ execId, result: outcome.result, ...logs, ...stamp, at })]
    }
    return [{ type: "CodeSettled", execId, error: outcome.error, ...logs, ...stamp, at }]
  }).pipe(Effect.scoped)

interface CodeState {
  readonly turns: TurnLifecycleState
  readonly dispatches: ReadonlyMap<string, Event>
  readonly owners: ReadonlySet<string>
  readonly settled: ReadonlySet<string>
  readonly calls: ReadonlyMap<string, { readonly execId: string }>
  readonly returned: ReadonlySet<string>
}

const CodeStateSchema = Schema.toCodecJson(Schema.Struct({
  turns: TurnLifecycleSchema, owners: Schema.ReadonlySet(Schema.String), dispatches: Schema.ReadonlyMap(Schema.String, PositionedEvent),
  settled: Schema.ReadonlySet(Schema.String), calls: Schema.ReadonlyMap(Schema.String, Schema.Struct({ execId: Schema.String })),
  returned: Schema.ReadonlySet(Schema.String)
}))

const codeExecutionProjection = (
  policy: Partial<CodePolicy>,
  packages: ReadonlyArray<PackageView>
): TransitionProjection<CodeState, KeyValueStore.KeyValueStore> => {
  const named = new Set<string>()
  for (const pkg of packages) {
    if (named.has(pkg.name)) throw new Error(`package "${pkg.name}" declared twice`)
    named.add(pkg.name)
  }
  const workspace = (packages).find((pkg) => pkg.name === "workspace")
  if (policy.spill?.note === undefined && workspace !== undefined) {
    const answers = (method: string, fields: ReadonlyArray<string>): boolean => {
      const properties = (workspace.docs?.[method]?.input as
        | { properties?: Readonly<Record<string, unknown>> }
        | undefined)?.properties
      return workspace.methods.includes(method) && (properties === undefined || fields.every((field) => properties[field] !== undefined))
    }
    if (!answers("read", ["ref"]) || !answers("grep", ["pattern", "ref"])) {
      throw new Error(
        'package "workspace" cannot answer the spill pointer: a bounded result tells the model `workspace.read({ref})` and `workspace.grep({pattern, ref})`. Provide both methods with matching input contracts, mount the package under another name, or state the pointer through the spill policy note (CodePolicy.spill.note).'
      )
    }
  }
  const spill = spillPolicyOf({
    ...policy.spill,
    note: policy.spill?.note ?? (workspace === undefined ? BARE_SPILL_NOTE : WORKSPACE_SPILL_NOTE)
  })
  const callPolicy = packageCallPolicyOf(policy.call)
  const ownerOf = (owners: ReadonlySet<string>, callId: string): string => {
    let owner = ""
    for (const execId of owners) {
      if (callId.startsWith(`${execId}.`) && execId.length > owner.length) owner = execId
    }
    return owner
  }
  return transitionProjection({
    initial: (): CodeState => ({
      turns: initialTurnLifecycle(),
      dispatches: new Map(),
      owners: new Set(),
      settled: new Set(),
      calls: new Map(),
      returned: new Set()
    }),
    step: (state, event): CodeState => {
      const dispatches = new Map(state.dispatches)
      const owners = new Set(state.owners)
      const settled = new Set(state.settled)
      const calls = new Map(state.calls)
      const returned = new Set(state.returned)
      const value = event as { readonly execId?: unknown; readonly callId?: unknown; readonly awaiting?: unknown; readonly id?: unknown; readonly at?: unknown }
      if (event.type === "CodeDispatched") {
        const execId = executionKeyOf(event)
        owners.add(execId)
        const prior = dispatches.get(execId) as { readonly at?: unknown } | undefined
        if (!settled.has(execId) && (prior === undefined || Number(value.at ?? 0) < Number(prior.at ?? 0))) dispatches.set(execId, event)
      }
      if (event.type === "CodeSettled") {
        const execId = executionKeyOf(event)
        settled.add(execId)
        dispatches.delete(execId)
        for (const [callId, call] of calls) if (call.execId === execId) calls.delete(callId)
      }
      if (event.type === "PackageCalled") {
        const callId = packageKeyOf(event)
        const execId = executionRefOf(event) === undefined ? ownerOf(owners, callId) : executionKeyOf(event)
        if (!returned.has(callId) && !settled.has(execId)) calls.set(callId, { execId })
      }
      if (event.type === "PackageReturned") {
        returned.add(packageKeyOf(event))
        calls.delete(packageKeyOf(event))
      }
      return {
        turns: event.type === "MessageReceived" ? state.turns : reduceTurnLifecycle(state.turns,
          Object.fromEntries(["type", "turn", "epoch", "failedEpoch"].filter(key => event[key] !== undefined).map(key => [key, event[key]])) as Event),
        dispatches, owners,
        settled,
        calls,
        returned
      }
    },
    output: (state) => {
      const ordered = [...state.dispatches.entries()].sort(([leftId, left], [rightId, right]) => {
        const time = Number((left as { readonly at?: unknown }).at ?? 0) - Number((right as { readonly at?: unknown }).at ?? 0)
        return time !== 0 ? time : leftId < rightId ? -1 : 1
      })
      let selected: { readonly execId: string; readonly dispatch: Event } | undefined
      for (const [execId, dispatch] of ordered) {
        const turn = turnOf(dispatch)
        if (state.settled.has(execId) || (turn !== undefined && turnTerminalFrom(state.turns, turn) !== undefined)) continue
        const owned = [...state.calls.entries()].filter(([, call]) => call.execId === execId)
        const open = owned.filter(([callId]) => !state.returned.has(callId))
        if (open.length === 0) selected = { execId, dispatch }
        break
      }
      if (selected === undefined) return []
      const { dispatch } = selected
      const turn = turnOf(dispatch)
      const epoch = eventEpochOf(dispatch)
      return [bindTransitionContext(dispatch, "code.execution").effect("execute", {
        ...(turn === undefined ? {} : { invocation: { method: "message", id: turn, epoch } }),
        input: {
          execId: String(dispatch.execId ?? ""),
          executionRef: executionRefOf(dispatch),
          code: String(dispatch.code ?? ""),
          turn,
          epoch,
          at: typeof dispatch.at === "number" ? dispatch.at : undefined
        },
        act: input => executeRecorded(input.execId, input.code, spill, callPolicy, packages, input.turn, input.epoch, input.at, input.executionRef)
      })]
    }
  })
}

// codeExecution adapts sandbox requests to child-owned calls (packages/agent/integration/package-permissions.test.ts).
export const codeExecution = <const Cs extends ReadonlyArray<CodeComponent<unknown>>>(
  children: Cs,
  policy: Partial<CodePolicy> = {}
): Component<CodeView, KeyValueStore.KeyValueStore | ComponentRequirements<Cs[number]>, ComponentResult<Cs[number]>> => {
  const scope = composeComponents("code.scope", CODE_VIEW_ALGEBRA, children, children.every(supportsCheckpoint) ? { checkpoint: { version: "1" } } : {})
  const empty = codeExecutionProjection(policy, [])
  return component({
    name: "code.execution",
    children: scope,
    ...(supportsCheckpoint(scope) ? { checkpoint: { version: "2", schema: CodeStateSchema } } : {}),
    initial: child => {
      codeExecutionProjection(policy, child.output().view.packages)
      return empty.initial()
    },
    step: (state, event) => empty.step(state, event),

    output: (state, child): ComponentOutput<CodeView, KeyValueStore.KeyValueStore | ComponentRequirements<Cs[number]>, ComponentResult<Cs[number]>> => {
      const output = child.output()
      return {
        ...output, transitions: [...codeExecutionProjection(policy, output.view.packages).output(state), ...output.transitions], interactions: {
          cancel: (cancellation): ReadonlyArray<import("@clavia/tardigrade-core/transition").Transition<never, KeyValueStore.KeyValueStore | ComponentRequirements<Cs[number]>>> => {
            const cleanup = child.output().interactions?.cancel?.(cancellation) ?? []
            if (cleanup.length > 0)
              return cleanup
            if (cancellation.invocation.method !== "message")
              return []
            return [...state.dispatches].flatMap(([key, dispatch]) => {
              if (state.settled.has(key) || turnOf(dispatch) !== cancellation.invocation.id || eventEpochOf(dispatch) !== cancellation.invocation.epoch)
                return []
              return [bindTransitionContext(dispatch, "code.execution").intent("execute", at => codeSettled({
                ...(executionRefOf(dispatch) === undefined ? {} : { executionRef: executionRefOf(dispatch)! }),
                execId: String(dispatch.execId),
                error: cancellation.reason === undefined ? "cancelled" : `cancelled: ${cancellation.reason}`,
                turn: cancellation.invocation.id, epoch: cancellation.invocation.epoch, at
              }), { invocation: null })]
            }).slice(0, 1)
          }
        }
      }
    }
  })
}
