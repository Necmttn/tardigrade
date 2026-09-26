
## Methods

Methods expose typed boundary input ports to the outside world. A machine's input and its actor method use the same token:

```ts
const OpenInput = Schema.Struct({})
const OpenDoor = interaction<typeof OpenInput.Type>("OpenDoor")

// In the door definition:
inputs: [
  input(OpenDoor, (_state: DoorState) => ({ type: "Open" as const })),
]

const room = actor({
  machines: [door],
  methods: { open: method(OpenInput, OpenDoor) },
})

const invocation = room.invoke("open", {})
const next = room.append(room.initial, invocation)
```

invoke validates the encoded input and produces an ActorMethodInvoked envelope carrying the method name and input. It does not advance state or perform persistence. The envelope contains no symbol identities and can be journaled with a suitable schema. On append or replay, the actor resolves the method against its current declarations, decodes the input, and delivers it once to the matching machine input. The input translates the payload into a local interaction; the receiving machine's current interface checks availability. The composition then settles.

Each method token requires exactly one receiving input. Missing or ambiguous receivers, duplicate method tokens, and an internal producer competing with a boundary input fail during construction. The diagram shows these connections from a world node. ActorMethodInvoked is reserved for boundary delivery and is excluded from the domain-event sequence passed to projections.

Methods must use synchronous decoding without additional services. Unknown method names, invalid input, and unavailable local interactions throw. Method bindings must remain compatible with persisted invocations for replay. A host must include method envelopes in its journal codec and delivery API to persist them; the existing agent host is not automatically extended by declaring methods.

The runnable example is [examples/world.ts](./examples/world.ts). It opens the door, reconstructs the open state from its invocation log, and closes it.
