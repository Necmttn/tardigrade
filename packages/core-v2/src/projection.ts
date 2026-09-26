import { isDeepStrictEqual } from "node:util";
import { compose, type Component, type CheckedPorts, type States } from "./compose";
import { mermaid } from "./diagram";

export type Projection<Event, State> = (events: readonly Event[]) => State;

export interface StateSource<Event, State> {
  readonly state: Projection<Event, State>;
}

export interface LogState<Event, State> {
  readonly events: readonly Event[];
  readonly machines: State;
}

// fromLog reconstructs machine states from the log, then propagates until consecutive states are equal.
// Unprojected machines restart from initial; live changes must be represented by events and projections to survive reconstruction.
export function fromLog<Event>() {
  return <const M extends readonly (Component & { readonly state?: Projection<Event, unknown> })[]>(
    siblings: M & CheckedPorts<M>,
    options: { readonly equals?: (previous: States<M>, next: States<M>) => boolean } = {},
  ) => {
    const equals = options.equals ?? isDeepStrictEqual;
    const machine = compose<M>(siblings);
    const replay = (events: readonly Event[]): LogState<Event, States<M>> => {
      const snapshot = Object.freeze([...events]);
      let states = Object.fromEntries(siblings.map((child) => [child.name, child.state ? child.state(snapshot) : child.initial])) as States<M>;
      while (true) {
        const next = machine.step(states);
        if (equals(states, next)) {
          states = next;
          break;
        }
        states = next;
      }
      return { events: snapshot, machines: states };
    };
    if (machine.wiring.machines.includes("event log")) throw new Error('"event log" is reserved by fromLog');
    return {
      initial: replay([]),
      replay,
      append: (state: LogState<Event, States<M>>, event: Event) => replay([...state.events, event]),
      view: (state: LogState<Event, States<M>>) => machine.view(state.machines),
      effects: (state: LogState<Event, States<M>>) => machine.effects(machine.view(state.machines)),
      diagram: () => mermaid({
        machines: ["event log", ...machine.wiring.machines],
        ports: machine.wiring.ports,
        connections: [
          ...siblings.filter((child) => child.state).map((child) => ({ from: "event log", to: child.name, port: "projection", kind: "projection" as const })),
          ...machine.wiring.connections,
        ],
      }),
    };
  };
}
