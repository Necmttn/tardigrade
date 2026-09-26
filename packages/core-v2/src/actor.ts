import { mermaid } from "./diagram"
import { isDeepStrictEqual } from "node:util"
import { decodeMethod, type ActorMethod } from "./method"
import { compose, type Component, type CheckedPorts, type States } from "./compose"
import type { MachineEffect, EffectsOf } from "./effects"
import type { LogState, Projection } from "./projection"

type EventsOf<C> = C extends { readonly state: (events: readonly (infer Event)[]) => unknown }
  ? Event
  : [EffectsOf<C>] extends [never] ? never : EffectsOf<C> extends MachineEffect<infer Event, unknown, unknown> ? Event : never

export type MethodInvocation<Methods extends Readonly<Record<string, ActorMethod>>> = {
  readonly [Name in keyof Methods & string]: {
    readonly type: "ActorMethodInvoked"
    readonly method: Name
    readonly input: Methods[Name]["input"]["Encoded"]
  }
}[keyof Methods & string]

export interface Actor<Event, State, Error = never, Services = never> {
  readonly initial: State
  readonly replay: (events: readonly Event[]) => State
  readonly append: (state: State, event: Event) => State
  readonly effects: (state: State) => readonly MachineEffect<Event, Error, Services>[]
}

// actor composes machines and binds named methods to their boundary input ports.
// Method envelopes are replayed as single deliveries; projections consume domain events.
export function actor<
  const Machines extends readonly Component[],
  const Methods extends Readonly<Record<string, ActorMethod>> = {},
>(options: {
  readonly machines: Machines & CheckedPorts<Machines>
  readonly methods?: Methods
  readonly equals?: (previous: States<Machines>, next: States<Machines>) => boolean
}) {
  type DomainEvent = EventsOf<Machines[number]>
  type Event = DomainEvent | MethodInvocation<Methods>
  type Snapshot = LogState<Event, States<Machines>>
  const methods = (options.methods ?? {}) as Methods
  const machine = compose<Machines>(options.machines, {
    boundaryInputs: Object.values(methods).map(method => method.port),
  })
  if (machine.wiring.machines.includes("event log")) throw new Error('"event log" is reserved by actor')
  const equals = options.equals ?? isDeepStrictEqual
  const settle = (state: States<Machines>): States<Machines> => {
    while (true) {
      const next = machine.step(state)
      if (equals(state, next)) return next
      state = next
    }
  }
  const project = (events: readonly DomainEvent[], previous: States<Machines>): States<Machines> =>
    Object.fromEntries(options.machines.map(child => {
      const projection = (child as Component & { readonly state?: Projection<DomainEvent, unknown> }).state
      return [child.name, projection ? projection(events) : previous[child.name as keyof States<Machines>]]
    })) as States<Machines>
  const replay = (events: readonly Event[]): Snapshot => {
    const history: DomainEvent[] = []
    let states = settle(project(history, machine.initial))
    for (const event of events) {
      if (typeof event === "object" && event !== null && "type" in event && event.type === "ActorMethodInvoked") {
        const invocation = event as MethodInvocation<Methods>
        if (!Object.hasOwn(methods, invocation.method)) throw new Error(`Unknown actor method: ${invocation.method}`)
        const method = methods[invocation.method]!
        states = settle(machine.receive(states, method.port, decodeMethod(method, invocation.input)))
      } else {
        history.push(event as DomainEvent)
        states = settle(project(Object.freeze([...history]), states))
      }
    }
    return { events: Object.freeze([...events]), machines: states }
  }
  return {
    initial: replay([]),
    replay,
    append: (state: Snapshot, event: Event) => replay([...state.events, event]),
    view: (state: Snapshot) => machine.view(state.machines),
    effects: (state: Snapshot) => machine.effects(machine.view(state.machines)),
    diagram: () => mermaid({
      ...machine.wiring,
      machines: ["event log", ...machine.wiring.machines],
      connections: [
        ...options.machines.filter(child => "state" in child).map(child => ({ from: "event log", to: child.name, port: "projection", kind: "projection" as const })),
        ...machine.wiring.connections,
      ],
    }),
    methods,
    invoke: <Name extends keyof Methods & string>(name: Name, input: Methods[Name]["input"]["Encoded"]): MethodInvocation<Methods> => {
      if (!Object.hasOwn(methods, name)) throw new Error(`Unknown actor method: ${name}`)
      decodeMethod(methods[name]!, input)
      return { type: "ActorMethodInvoked", method: name, input } as MethodInvocation<Methods>
    },
  }
}
