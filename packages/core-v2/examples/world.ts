import { Schema } from "effect"
import { actor, defineInterface, defineMachine, input, interaction, method } from "../src"

const OpenInput = Schema.Struct({})
const CloseInput = Schema.Struct({})
const OpenDoor = interaction<typeof OpenInput.Type>("OpenDoor")
const CloseDoor = interaction<typeof CloseInput.Type>("CloseDoor")
const Open = Schema.Struct({ type: Schema.Literal("Open") })
const Close = Schema.Struct({ type: Schema.Literal("Close") })
const DoorInterface = defineInterface({
  closed: { view: Schema.Struct({}), interactions: { Open } },
  open: { view: Schema.Struct({}), interactions: { Close } },
})
const door = defineMachine({
  name: "door",
  interface: DoorInterface,
  initial: { open: false },
  view: state => ({ position: state.open ? "open" : "closed" }),
  inputs: [
    input(OpenDoor, (_state: { open: boolean }) => ({ type: "Open" as const })),
    input(CloseDoor, (_state: { open: boolean }) => ({ type: "Close" as const })),
  ],
  transitions: {
    Open: state => ({ ...state, open: true }),
    Close: state => ({ ...state, open: false }),
  },
})
const room = actor({
  machines: [door],
  methods: {
    open: method(OpenInput, OpenDoor),
    close: method(CloseInput, CloseDoor),
  },
})
const opened = room.append(room.initial, room.invoke("open", {}))
console.log(room.view(opened))
console.log(room.view(room.replay(opened.events)))
console.log(room.view(room.append(opened, room.invoke("close", {}))))
console.log(room.diagram())
