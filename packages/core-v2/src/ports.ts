// Output --shared token--> Input --local interaction--> Transition

export interface Token<Payload> {
  readonly id: symbol;
  readonly name: string;
  readonly payload: (value: Payload) => Payload;
}

// interaction creates a runtime identity shared by compatible input and output ports.
export function interaction<Payload>(name: string): Token<Payload> {
  return { id: Symbol(name), name, payload: (value) => value };
}

export interface InputPort<State, Event> {
  readonly id: symbol;
  readonly name: string;
  readonly receive: (state: State, payload: unknown) => Event;
}

export interface OutputPort<View> {
  readonly id: symbol;
  readonly name: string;
  readonly broadcast: boolean;
  readonly read: (position: View) => { readonly value: unknown } | undefined;
}

// input translates a matched port's payload into a local interaction.
export function input<Payload, State, Event>(
  token: Token<Payload>,
  receive: (state: State, payload: NoInfer<Payload>) => Event,
): InputPort<State, Event> {
  return { id: token.id, name: token.name, receive: (state, payload) => receive(state, payload as Payload) };
}

// output emits a payload or remains inactive for the public position.
export function output<Payload, View>(
  token: Token<Payload>,
  read: (position: View) => { readonly value: NoInfer<Payload> } | undefined,
  options: { readonly broadcast?: boolean } = {},
): OutputPort<View> {
  return { id: token.id, name: token.name, read, broadcast: options.broadcast ?? false };
}
