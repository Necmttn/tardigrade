import fc from "fast-check"
import { describe, expect, test } from "bun:test"
import { machineOf } from "../../../core/src/component/runtime"
import { eventAt, type Event } from "@clavia/tardigrade-core/event"
import { codeExecution } from "./code"
import { Schema } from "effect"
import { TurnLifecycleSchema, initialTurnLifecycle, reduceTurnLifecycle, currentTurnFrom, turnEpochFrom, turnTerminalAtFrom } from "./turn-lifecycle"
import { turnHead, turnEpochOf, eventEpochOf } from "./turns"

describe("dispatch retention", () => {
  test("settled code drops dispatch payloads and keeps duplicate suppression after restore", () => {
    const machine = machineOf(codeExecution([]))
    const marker = "discard_this_code_payload".repeat(1000)
    const dispatch = eventAt({ type: "CodeDispatched", execId: "run", code: marker, at: 1 }, 1)
    let state = machine.step(machine.initial(), dispatch)
    expect(JSON.stringify(machine.checkpoint!.encode(state))).toContain(marker)
    state = machine.step(state, eventAt({ type: "CodeSettled", execId: "run", result: "done" }, 2))
    expect(JSON.stringify(machine.checkpoint!.encode(state))).not.toContain(marker)
    const fresh = machineOf(codeExecution([]))
    state = fresh.checkpoint!.decode(JSON.parse(JSON.stringify(machine.checkpoint!.encode(state))))
    state = fresh.step(state, eventAt({ ...dispatch, at: 0 }, 3))
    expect(fresh.output(state).transitions).toEqual([])
    expect(JSON.stringify(fresh.checkpoint!.encode(state))).not.toContain(marker)
  })
})

describe("turn lifecycle", () => {
  const codec = Schema.toCodecJson(TurnLifecycleSchema)
  const encode = Schema.encodeSync(codec)
  const decode = Schema.decodeUnknownSync(codec)

  test("lifecycle facts match replay through queued turns, out-of-order epochs, and every checkpoint cut", () => {
    fc.assert(fc.property(fc.array(fc.record({
      type: fc.constantFrom("TurnFailed", "TurnResumed", "TurnCompleted", "TurnCancelled", "ToolReturned"),
      turn: fc.constantFrom("a", "b"), epoch: fc.integer({ min: 0, max: 3 })
    }), { maxLength: 25 }), events => {
      const log: Event[] = [
        { type: "MessageReceived", id: "a" }, { type: "MessageReceived", id: "b" },
        ...events.map(event => ({ ...event, failedEpoch: event.epoch - 1 }))
      ].map((event, index) => eventAt(event, index + 1))
      for (let cut = 0; cut <= log.length; cut++) {
        let state = log.slice(0, cut).reduce(reduceTurnLifecycle, initialTurnLifecycle())
        state = decode(JSON.parse(JSON.stringify(encode(state))))
        for (let position = cut; position <= log.length; position++) {
          const prefix = log.slice(0, position)
          expect(currentTurnFrom(state)?.head.event).toEqual(turnHead(prefix))
          for (const id of ["a", "b"]) {
            expect(turnEpochFrom(state, id)).toBe(turnEpochOf(prefix, id))
            for (let epoch = 0; epoch <= 3; epoch++) expect(turnTerminalAtFrom(state, id, epoch)).toEqual(prefix.findLast(event =>
              event.turn === id && eventEpochOf(event) === epoch && ["TurnCompleted", "TurnFailed", "TurnCancelled"].includes(event.type)))
          }
          state = decode(JSON.parse(JSON.stringify(encode(state))))
          if (position < log.length) state = reduceTurnLifecycle(state, log[position]!)
        }
      }
    }), { numRuns: 100 })
  })

  test("execution payloads do not grow lifecycle state", () => {
    const state = reduceTurnLifecycle(initialTurnLifecycle(), { type: "MessageReceived", id: "turn" })
    let next = state
    for (let index = 0; index < 1000; index++) next = reduceTurnLifecycle(next, { type: "ToolReturned", turn: "turn", callId: String(index), result: "payload".repeat(1000) })
    expect(next).toBe(state)
    expect(encode(next)).toEqual(encode(state))
  })
})
