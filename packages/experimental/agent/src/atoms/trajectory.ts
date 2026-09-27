import { durableAtom } from "@clavia/tardigrade-experimental-core"
import { Conversation, trajectoryState } from "../projections"

export const trajectory = durableAtom({
  schema: Conversation,
  initial: [], reduce: trajectoryState,
})
