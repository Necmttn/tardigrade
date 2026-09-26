import type { InteractionSchemas, InputsOf } from "./interactions";
import type { MachineInterface, DeclaredMachineInterface, InteractionsByPosition } from "./interface";
import type { SchemasFor } from "./interactions";
import type { MachineEffect } from "./effects";
// State --view--> View --output ports--> Other machines
// State + interaction --transition--> Next state

import type { InputPort, OutputPort } from "./ports";

export type PublicPosition = string | { readonly position: string };
export type ModeOf<P extends PublicPosition> = P extends string ? P : P extends { readonly position: infer Mode extends string } ? Mode : never;
export type InteractionName<I> = I extends string ? I : I extends { readonly type: infer Name extends string } ? Name : never;
type MatchingInteraction<I, Name extends string> = I extends string ? Extract<I, Name> : Extract<I, { readonly type: Name }>;

// Transition computes the next internal state from the current state and an interaction.
export type Transition<State, Input> = (state: State, input: Input) => State;

// Machine exposes a public position and the transitions available at each position tag.
export interface Machine<
  State,
  View extends PublicPosition,
  Interaction extends { [Mode in ModeOf<View>]: string | { readonly type: string } },
> {
  readonly name: string;
  readonly initial: State;
  readonly view: (state: State) => View;
  readonly interface: MachineInterface<View, { [Mode in ModeOf<View>]: SchemasFor<Interaction[Mode]> }[ModeOf<View>]>;
  readonly inputs?: readonly InputPort<State, Interaction[ModeOf<View>]>[];
  readonly effects?: (position: View) => readonly MachineEffect<unknown, unknown, unknown>[];
  readonly outputs?: readonly OutputPort<View>[];
  readonly transitions: {
    readonly [Mode in ModeOf<View>]: {
      readonly [Name in InteractionName<Interaction[Mode]>]: Transition<State, MatchingInteraction<Interaction[Mode], Name>>;
    };
  };
}


type DeclaredInterface = Omit<DeclaredMachineInterface<PublicPosition, Record<string, InteractionSchemas>>, "interactions" | "outputs"> & {
  readonly outputs: readonly OutputPort<never>[];
  readonly interactions: (position: never) => InteractionSchemas;
};

type Handlers<State, Schemas extends InteractionSchemas> = {
  readonly [Name in InteractionName<InputsOf<Schemas>>]: Transition<State, MatchingInteraction<InputsOf<Schemas>, Name>>;
};
type ContractInteractions<Contract extends DeclaredInterface> = InteractionsByPosition<Contract>;
type DeclaredTransitions<State, Contract extends DeclaredInterface> = {
  readonly [Mode in keyof ContractInteractions<Contract>]: Handlers<State, ContractInteractions<Contract>[Mode]>;
};

export const DEFAULT_MACHINE_NAME = "machine";

// defineMachine supplies shared interaction handlers for the positions declared by its interface.
// Instances and composition check current availability before calling a handler.
export function defineMachine<
  State,
  const Contract extends DeclaredInterface,
  const Name extends string = typeof DEFAULT_MACHINE_NAME,
  const Effects extends readonly MachineEffect<unknown, unknown, unknown>[] = readonly [],
>(
  definition: {
    readonly interface: Contract;
    readonly name?: Name;
    readonly initial: State;
    readonly view: (state: NoInfer<State>) => Contract["view"]["Type"];
    readonly transitions: NoInfer<Handlers<State, ReturnType<Contract["interactions"]>>>;
    readonly inputs?: readonly InputPort<NoInfer<State>, InputsOf<ReturnType<Contract["interactions"]>>>[];
    readonly effects?: (position: Contract["view"]["Type"]) => Effects;
  },
) {
  const contract = definition.interface;
  return {
    ...definition,
    name: (definition.name ?? DEFAULT_MACHINE_NAME) as Name,
    interface: contract,
    outputs: contract.outputs as readonly OutputPort<Contract["view"]["Type"]>[],
    transitions: Object.fromEntries(contract.positions.map(position => [
      position, definition.transitions,
    ])) as DeclaredTransitions<State, Contract>,
    effects: (position: Contract["view"]["Type"]): readonly Effects[number][] =>
      definition.effects?.(position) ?? [],
  };
}
