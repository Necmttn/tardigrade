import { Router } from "../transport/router"
import { Self } from "../runtime/context"
import type { TransitionContext } from "../transition/transition"
import type { Event } from "../event"
import { expect, expectTypeOf, test } from "bun:test"
import { Context, Effect, Layer, Ref, Schema } from "effect"
import { component } from "./machine"
import { machineOf } from "./runtime"
import { composeComponents } from "./composition/siblings"
import type { ComponentRequirements } from "./component"
import { actor } from "../actor/definition"
import { EventLog, withWatermark } from "../log"
import { createActorReconciler } from "../runtime/reconciler"

class Catalog extends Context.Service<Catalog, { readonly label: string }>()("test/Catalog") {}
const reader = () => component({
  name: "reader",
  dependencies: [Catalog],
  initial: (_children, [catalog]) => ({ catalog, context: undefined as TransitionContext | undefined }),
  step: (state, event, context) => event.type === "Start" ? { ...state, context } : event.type === "Read" ? { ...state, context: undefined } : state,
  output: state => ({ view: state.catalog.label, transitions: state.context === undefined ? [] : [state.context.intent("read", { type: "Read", label: state.catalog.label })] })
})

test("data requirements survive wrappers and sibling composition", () => {
  const child = reader()
  const parent = component({ name: "parent", children: child, initial: () => undefined, step: state => state,
    output: (_state, child) => ({ view: child.output().view, transitions: [] }) })
  const siblings = composeComponents("siblings", { empty: "", combine: (left: string, right: string) => left + right }, [parent])
  expectTypeOf<ComponentRequirements<typeof child>>().toEqualTypeOf<Catalog>()
  expectTypeOf<ComponentRequirements<typeof parent>>().toEqualTypeOf<Catalog>()
  expectTypeOf<ComponentRequirements<typeof siblings>>().toEqualTypeOf<Catalog>()
  const machine = machineOf(siblings)
  expect(() => machine.initial()).toThrow("test/Catalog")
  const first = machine.initial(Context.make(Catalog, { label: "first" }))
  const second = machine.initial(Context.make(Catalog, { label: "second" }))
  expect(machine.output(first).view).toBe("first")
  expect(machine.output(second).view).toBe("second")
  expect(machine.output(first).view).toBe("first")
})

test("runtime binds data once per reconciler activation", async () => {
  const child = reader()
  const reconciler = createActorReconciler(actor({ name: "reader", methods: {}, components: [child] }))
  const events = await Effect.runPromise(Effect.gen(function* () {
    const ref = yield* Ref.make<ReadonlyArray<Event>>([{ type: "Start" }])
    const log = withWatermark({ append: batch => Ref.update(ref, prior => [...prior, ...batch]), read: Ref.get(ref) })
    yield* reconciler.settle.pipe(Effect.provideService(EventLog, log), Effect.provide(Layer.succeed(Catalog, { label: "first" })))
    yield* log.append([{ type: "Start" }])
    yield* reconciler.settle.pipe(Effect.provideService(EventLog, log), Effect.provide(Layer.succeed(Catalog, { label: "second" })))
    return yield* log.read
  }).pipe(Effect.provideService(Router, { send: () => Effect.void }), Effect.provideService(Self, { actor: "reader", instance: "main", thread: "root" })))
  expect(events.filter(event => event.type === "Read").map(event => event.label)).toEqual(["first", "first"])
})

class Formatter extends Context.Service<Formatter, { readonly format: (value: number) => string }>()("test/Formatter") {}

test("checkpoint restore binds output services independently of durable state", () => {
  let initialCalls = 0
  let oldCalls = 0
  let freshCalls = 0
  const make = () => machineOf(component({
    name: "formatted",
    dependencies: [Formatter] as const,
    checkpoint: { version: "1", schema: Schema.Finite },
    initial: () => { initialCalls++; return 0 },
    step: state => state + 1,
    output: (state, _children, [formatter]) => ({ view: formatter.format(state), transitions: [] })
  }))
  const original = make()
  const state = original.step(original.initial(Context.make(Formatter, { format: value => { oldCalls++; return `value:${value}` } })), { type: "Tick" })
  const encoded = JSON.parse(JSON.stringify(original.checkpoint!.encode(state)))
  expect(encoded).toEqual({ component: "formatted", version: "1", state: 1 })
  const fresh = make()
  expect(() => fresh.checkpoint!.decode(encoded)).toThrow("test/Formatter")
  const restored = fresh.checkpoint!.decode(encoded, Context.make(Formatter, { format: value => { freshCalls++; return `value:${value}` } }))
  expect(initialCalls).toBe(1)
  expect(fresh.output(restored).view).toBe(original.output(state).view)
  expect(freshCalls).toBe(1)
  expect(oldCalls).toBe(2)
  expect(fresh.output(fresh.step(restored, { type: "Tick" })).view).toBe("value:2")
  expect(freshCalls).toBe(2)
  expect(oldCalls).toBe(2)
})
