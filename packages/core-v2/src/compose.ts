import { validateView } from "./interface";
import type { MachineInterface } from "./interface";
import { Schema } from "effect";
import { validateInteraction, type InteractionSchemas, type InputsOf } from "./interactions";
import type { MachineEffect, CombinedEffects } from "./effects";
// Machines --matching ports--> Delivered interactions --transitions--> Next states

import type { Machine } from "./machine";
import { mermaid } from "./diagram";
import type { InputPort, OutputPort } from "./ports";

export interface Component {
  readonly name: string;
  readonly combine?: (state: never, interactions: readonly never[]) => unknown;
  readonly inputs?: readonly InputPort<never, unknown>[];
  readonly outputs?: readonly OutputPort<never>[];
  readonly effects?: (position: never) => readonly MachineEffect<unknown, unknown, unknown>[];
  readonly interface: { readonly view: Schema.ConstraintDecoder<string | { readonly position: string }>; readonly interactions: (position: never) => InteractionSchemas };
  readonly initial: unknown;
  readonly view: (state: never) => string | { readonly position: string };
  readonly transitions: Readonly<Record<string, Readonly<Record<string, (state: never, interaction: never) => unknown>>>>;
}

export type States<M extends readonly Component[]> = {
  readonly [C in M[number] as C["name"]]: Parameters<C["view"]>[0];
};

export type Positions<M extends readonly Component[]> = {
  readonly [C in M[number] as C["name"]]: ReturnType<C["view"]>;
};

type Interaction<C extends Component> = InputsOf<ReturnType<C["interface"]["interactions"]>>;

export type Delivery<M extends readonly Component[]> = {
  readonly [C in M[number] as C["name"]]?: Interaction<C>;
};

export interface Composition<State, Input> {
  readonly deliver: (state: State, input: Input) => State;
  readonly wire: (state: State) => Input;
}

export interface ComposedPosition<M extends readonly Component[]> {
  readonly position: "composed";
  readonly children: Positions<M>;
}

export type ComposedInteraction<M extends readonly Component[]> =
  | { readonly type: "Tick" }
  | { readonly type: "Deliver"; readonly input: Delivery<M> };

export type CheckedPorts<M extends readonly Component[]> = {
  readonly [K in keyof M]: { readonly view: M[K]["view"]; readonly interface: MachineInterface<ReturnType<M[K]["view"]>>; readonly outputs?: readonly OutputPort<ReturnType<M[K]["view"]>>[]; readonly effects?: (position: ReturnType<M[K]["view"]>) => readonly MachineEffect<unknown, unknown, unknown>[] };
};

export interface ComposeOptions<M extends readonly Component[], Name extends string> {
  readonly name?: Name;
  readonly boundaryInputs?: readonly { readonly id: symbol; readonly name: string }[];
  readonly inputs?: readonly InputPort<States<M>, ComposedInteraction<M>>[];
  readonly outputs?: readonly OutputPort<ComposedPosition<M>>[];
}

// compose connects each input to one producer and delivers broadcast outputs to their subscribed consumers.
// Duplicate names and missing or ambiguous matches throw at construction.
// Machines omitted from a delivery retain their state.
export function compose<const M extends readonly Component[], const Name extends string = "composition">(
  siblings: M & CheckedPorts<M>,
  options: ComposeOptions<M, Name> = {},
) {
  const names = new Set<string>();
  for (const machine of siblings) {
    if (names.has(machine.name)) throw new Error(`Duplicate machine name: ${machine.name}`);
    names.add(machine.name);
  }
  const ordered = [...siblings].sort((a, b) => a.name < b.name ? -1 : a.name > b.name ? 1 : 0);
  const machines: Readonly<Record<string, Component>> = Object.fromEntries(ordered.map((machine) => [machine.name, machine]));
  const inputs = Object.entries(machines).flatMap(([key, machine]) =>
    (machine.inputs ?? []).map((port) => ({ key, port })),
  );
  const outputs = Object.entries(machines).flatMap(([key, machine]) =>
    (machine.outputs ?? []).map((port) => ({ key, port })),
  );
  const boundary = options.boundaryInputs ?? [];
  if (new Set(boundary.map(port => port.id)).size !== boundary.length) throw new Error("Duplicate boundary input token");
  if (boundary.length && names.has("world")) throw new Error('"world" is reserved for boundary inputs');
  const external = boundary.map(port => {
    const matches = inputs.filter(receiver => receiver.port.id === port.id);
    if (matches.length !== 1) throw new Error(`Boundary input ${port.name}: expected one receiver, found ${matches.length}`);
    if (outputs.some(sender => sender.port.id === port.id)) throw new Error(`Boundary input ${port.name} also has an internal producer`);
    return { port, receiver: matches[0]! };
  });
  const routes = inputs.filter(receiver => !boundary.some(port => port.id === receiver.port.id)).map((receiver) => {
    const matches = outputs.filter((sender) => sender.key !== receiver.key && sender.port.id === receiver.port.id);
    if (matches.length !== 1) {
      throw new Error(`${receiver.key}.${receiver.port.name}: expected one output, found ${matches.length}`);
    }
    return { sender: matches[0]!, receiver };
  });
  for (const sender of outputs) {
    const matches = routes.filter((route) => route.sender === sender);
    if (matches.length !== 1 && !sender.port.broadcast) {
      throw new Error(`${sender.key}.${sender.port.name}: expected one input, found ${matches.length}`);
    }
  }
  function childPositions(state: States<M>): Positions<M> {
    return Object.fromEntries(Object.entries(machines).map(([key, machine]) =>
      [key, validateView(machine.interface.view, machine.view(state[key as keyof States<M>] as never))],
    )) as Positions<M>;
  }

  function deliver(state: States<M>, input: Delivery<M>): States<M> {
    for (const key of Object.keys(input)) {
      if (!Object.hasOwn(machines, key)) throw new Error(`Unknown machine "${key}"`);
    }
    const next = { ...state };
    for (const [key, machine] of Object.entries(machines)) {
      if (!Object.hasOwn(input, key)) continue;
      const interaction: unknown = input[key as keyof Delivery<M>];
      const position = validateView(machine.interface.view, machine.view(state[key as keyof States<M>] as never));
      const mode = typeof position === "string" ? position : position.position;
      const { name, value } = validateInteraction(machine.interface.interactions(position as never), interaction);
      const transitions = Object.hasOwn(machine.transitions, mode) ? machine.transitions[mode] : undefined;
      if (!transitions || !Object.hasOwn(transitions, name)) {
        throw new Error(`No transition for interaction "${name}" at ${key}:${mode}`);
      }
      const updated = transitions[name]!(state[key as keyof States<M>] as never, value as never);
      validateView(machine.interface.view, machine.view(updated as never));
      Object.assign(next, { [key]: updated });
    }
    return next;
  }

  function wire(state: States<M>): Delivery<M> {
    const incoming = new Map<string, unknown[]>();
    const positions = childPositions(state);
    const emissions = new Map(outputs.map((sender) => [sender, sender.port.read(positions[sender.key as keyof Positions<M>] as never)]));
    for (const { sender, receiver } of routes) {
      const emission = emissions.get(sender);
      if (emission === undefined) continue;
      const interactions = incoming.get(receiver.key) ?? [];
      interactions.push(receiver.port.receive(state[receiver.key as keyof States<M>] as never, emission.value));
      incoming.set(receiver.key, interactions);
    }
    const delivery: Record<string, unknown> = {};
    for (const [key, interactions] of incoming) {
      const machine = machines[key]!;
      if (machine.combine) {
        delivery[key] = machine.combine(state[key as keyof States<M>] as never, interactions as never[]);
      } else {
        if (interactions.length !== 1) throw new Error(`Multiple active interactions for machine "${key}" require combine`);
        delivery[key] = interactions[0];
      }
    }
    return delivery as Delivery<M>;
  }
  const initial = Object.fromEntries(Object.entries(machines).map(([key, machine]) => [key, machine.initial])) as States<M>;
  const view = (state: States<M>): ComposedPosition<M> => ({ position: "composed", children: childPositions(state) });
  const tick = (state: States<M>) => deliver(state, wire(state));
  const machine = {
    name: (options.name ?? "composition") as Name,
    initial,
    view,
    interface: {
      view: Schema.Struct({
        position: Schema.Literal("composed"),
        children: Schema.Struct(Object.fromEntries(Object.entries(machines).map(([key, child]) => [key, Schema.toType(child.interface.view)]))),
      }) as unknown as Schema.ConstraintDecoder<ComposedPosition<M>>,
    interactions: (position: ComposedPosition<M>): {
      readonly Tick: Schema.ConstraintDecoder<{ readonly type: "Tick" }>;
      readonly Deliver: Schema.ConstraintDecoder<{ readonly type: "Deliver"; readonly input: Delivery<M> }>;
    } => {
      const fields = Object.fromEntries(Object.entries(machines).map(([key, child]) => [
        key,
        Schema.optionalKey(Schema.Union(Object.values(child.interface.interactions(position.children[key as keyof Positions<M>] as never))).pipe(Schema.toType)),
      ]));
      const delivery = Schema.Struct(fields) as unknown as Schema.ConstraintDecoder<Delivery<M>>;
      return {
        Tick: Schema.Struct({ type: Schema.Literal("Tick") }),
        Deliver: Schema.Struct({ type: Schema.Literal("Deliver"), input: delivery }),
      };
    },
    },
    effects: (position: ComposedPosition<M>) => siblings.flatMap((child) => child.effects?.(position.children[child.name as keyof Positions<M>] as never) ?? []) as unknown as readonly CombinedEffects<M[number]>[],
    transitions: {
      composed: {
        Tick: (state: States<M>, _interaction: { readonly type: "Tick" }) => tick(state),
        Deliver: (state: States<M>, interaction: { readonly type: "Deliver"; readonly input: Delivery<M> }) => deliver(state, interaction.input),
      },
    },
    inputs: options.inputs ?? [],
    outputs: options.outputs ?? [],
  } as const satisfies Machine<States<M>, ComposedPosition<M>, { composed: ComposedInteraction<M> }>;
  const wiring = {
    machines: [...(external.length ? ["world"] : []), ...ordered.map((child) => child.name)],
    ports: [
      ...external.map(({ port }) => ({ machine: "world", name: port.name, direction: "out" as const })),
      ...inputs.map(({ key, port }) => ({ machine: key, name: port.name, direction: "in" as const })),
      ...outputs.map(({ key, port }) => ({ machine: key, name: port.name, direction: "out" as const })),
    ],
    connections: [...external.map(({ port, receiver }) => ({ from: "world", to: receiver.key, port: port.name })), ...routes.map(({ sender, receiver }) => ({
      from: sender.key, to: receiver.key, port: sender.port.name,
    }))],
  };
  return {
    ...machine,
    wiring,
    diagram: () => mermaid(wiring),
    deliver: (state: States<M>, input: Delivery<M>) => machine.transitions.composed.Deliver(state, { type: "Deliver", input }),
    receive: (state: States<M>, token: { readonly id: symbol }, payload: unknown): States<M> => {
      const route = external.find(route => route.port.id === token.id);
      if (!route) throw new Error("Unknown boundary input");
      const { key, port } = route.receiver;
      const interaction = port.receive(state[key as keyof States<M>] as never, payload);
      return deliver(state, { [key]: interaction } as Delivery<M>);
    },
    wire,
    step: (state: States<M>) => machine.transitions.composed.Tick(state, { type: "Tick" }),
  };
}
