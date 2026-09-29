import { Schema } from "effect"
import { TurnLifecycleSchema } from "@clavia/tardigrade-code/execution/turn-lifecycle"
import type { Event } from "@clavia/tardigrade-core/log/event"
import {
  initialTurnLifecycle,
  reduceTurnLifecycle,
  currentTurnFrom
} from "@clavia/tardigrade-code/execution/turn-lifecycle"
import { component } from "@clavia/tardigrade-core/actor"
import { correctionAttemptsErrors, declaredOutputOf, type OutputFallback } from "../output/contract"
import { defineOutputFallback, type OutputFallbackComponent } from "./infer/index"

// RepairPolicy sets the correction limit and completed-history projection. `attempts` counts correction requests after the initial request (src/projection/transcript.ts, projectedOutput).
export interface RepairPolicy {
  readonly attempts: number
  readonly projectHistory: boolean
}

export const DEFAULT_REPAIR_POLICY: RepairPolicy = { attempts: 2, projectHistory: true }

// repairPolicyOf applies DEFAULT_REPAIR_POLICY and validates each override (turn.test.ts, "a bound that is not a whole count of asks is refused where it is stated").
export const repairPolicyOf = (policy: Partial<RepairPolicy> = {}): RepairPolicy => {
  const attempts = policy.attempts ?? DEFAULT_REPAIR_POLICY.attempts
  const problems = correctionAttemptsErrors(attempts)
  if (problems.length > 0) throw new Error(`the repair policy is not applicable: ${problems.join("; ")}`)
  const projectHistory = policy.projectHistory ?? DEFAULT_REPAIR_POLICY.projectHistory
  if (typeof projectHistory !== "boolean") {
    throw new Error(
      `the repair policy is not applicable: projectHistory must be true or false, got ${JSON.stringify(projectHistory)}`
    )
  }
  return { attempts, projectHistory }
}

// repairFallback returns the validated fallback record interpreted by the inference machine.
export const repairFallback = (policy: Partial<RepairPolicy> = {}): OutputFallback => {
  const resolved = repairPolicyOf(policy)
  return {
    kind: "repair",
    name: "repair",
    attempts: resolved.attempts,
    projectHistory: resolved.projectHistory
  }
}

// outputSystemFor returns the schema instruction used only in fallback mode (component/infer/index.ts, OutputFragment).
export const outputSystemFor = (name: string, schema: unknown): string =>
  `Your final reply for this turn must be JSON conforming to the schema "${name}":\n${JSON.stringify(schema)}\nReply with that JSON alone: no prose around it, no code fence.`

// declarationEvent retains lifecycle coordinates and the head's output declaration (turn.test.ts).
const declarationEvent = (event: Event): Event => Object.fromEntries(
  ["type", "id", "turn", "epoch", "failedEpoch", ...(event.type === "MessageReceived" ? ["output"] : [])]
    .filter(key => event[key] !== undefined).map(key => [key, event[key]])
) as Event

// declaredSystem returns the fallback instruction for the current declared contract.
const declaredSystem = (head: Event | undefined): { readonly system?: string } => {
  const declared = declaredOutputOf(head === undefined ? [] : [head])
  return declared.kind === "contract"
    ? { system: outputSystemFor(declared.contract.name, declared.contract.schema) }
    : {}
}

const outputFallback = (name: string, fallback: OutputFallback): OutputFallbackComponent => defineOutputFallback(component({
  name,
  checkpoint: { version: "2", schema: Schema.toCodecJson(TurnLifecycleSchema) },
  initial: initialTurnLifecycle,
  step: (state, event) => reduceTurnLifecycle(state, declarationEvent(event)),
  output: (state) => ({
    view: {
      system: [],
      tools: [],
      context: [],
      output: [{ component: name, kind: "fallback", fallback, ...declaredSystem(currentTurnFrom(state)?.head.event) }]
    },
    transitions: []
  })
}))

// outputRepairFor derives the framework correction loop under a stated policy.
export const outputRepairFor = (policy: Partial<RepairPolicy> = {}): OutputFallbackComponent =>
  outputFallback("output.repair", repairFallback(policy))

// outputRepair is the component under the default policy.
export const outputRepair: OutputFallbackComponent = outputRepairFor()

// VALIDATE_ONCE_FALLBACK validates one result and schedules no correction.
export const VALIDATE_ONCE_FALLBACK: OutputFallback = { kind: "local", name: "validate-once" }

// outputValidateOnce contributes one local validation and its contract instruction (turn.test.ts, "the validate-once implementation").
export const outputValidateOnce: OutputFallbackComponent = outputFallback("output.validate-once", VALIDATE_ONCE_FALLBACK)
