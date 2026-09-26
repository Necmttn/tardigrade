import type { Effect } from "./effect";

// MachineEffect carries a request, its execution, and whether the request is already recorded.
export interface MachineEffect<Event, Error = never, Services = never> extends Effect<Event, Event, Error, Services> {
  readonly recorded?: boolean;
}

// EffectsOf preserves the event, failure, and service types exposed by a machine.
export type EffectsOf<C> = C extends { readonly effects: (...args: never[]) => readonly (infer W extends MachineEffect<unknown, unknown, unknown>)[] } ? W : never;

// firstEffect selects an effect in composition order; remaining effects are reconsidered after each result.
export const firstEffect = <E>(effects: readonly E[]): E | undefined => effects[0];

type Events<W> = W extends MachineEffect<infer Event, unknown, unknown> ? Event : never;
type Errors<W> = W extends MachineEffect<unknown, infer Error, unknown> ? Error : never;
type Services<W> = W extends MachineEffect<unknown, unknown, infer R> ? R : never;
export type CombinedEffects<C> = MachineEffect<Events<EffectsOf<C>>, Errors<EffectsOf<C>>, Services<EffectsOf<C>>>;
