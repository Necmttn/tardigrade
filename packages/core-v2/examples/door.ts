import { Schema } from "effect"
import { compose, defineInterface, instantiate, defineMachine, interaction, output } from "../src"

const Open = Schema.Struct({ type: Schema.Literal("Open") })
const Close = Schema.Struct({ type: Schema.Literal("Close") })

export const DoorStatus = interaction<"closed" | "open">("DoorStatus")

export const DoorInterface = defineInterface({
  closed: {
    view: Schema.Struct({}),
    interactions: { Open },
    outputs: [output(DoorStatus, () => ({ value: "closed" as const }), { broadcast: true })],
  },
  open: {
    view: Schema.Struct({}),
    interactions: { Close },
    outputs: [output(DoorStatus, () => ({ value: "open" as const }), { broadcast: true })],
  },
})

export const doorDefinition = defineMachine({
  interface: DoorInterface,
  name: "door",
  initial: { open: false },
  view: state => ({
    position: state.open ? "open" : "closed",
  }),
  transitions: {
    Open: state => ({ ...state, open: true }),
    Close: state => ({ ...state, open: false }),
  },
})

export const door = instantiate(doorDefinition)
export const room = compose([doorDefinition], { name: "room" })

export const DoorAngle = interaction<number>("DoorAngle")

const OpenFurther = Schema.Struct({ type: Schema.Literal("OpenFurther") })

export const AdjustableDoorInterface = defineInterface({
  closed: {
    view: Schema.Struct({}),
    interactions: { Open },
  },
  open: {
    view: Schema.Struct({ angle: Schema.Number }),
    interactions: ({ angle }) => angle < 90 ? { Close, OpenFurther } : { Close },
    outputs: [output(DoorAngle, ({ angle }: { readonly angle: number }) => ({ value: angle }), { broadcast: true })],
  },
})
