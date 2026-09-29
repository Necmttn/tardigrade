import { Context, Option, Schema } from "effect"
import { SuppliedInteractions, inputScopesOf, type InteractionScope } from "../../transition/interaction"
import { eventPositionOf } from "../../event"
import { machineOf } from "../runtime"
import { bindTransitionContext, validateTransitions } from "../../transition/transition"
import { materializeProjection, type Projection, type MaterializedProjectionState } from "@clavia/tardigrade-core/projection"
import type { Component } from "../component"
import type { ComponentOutput } from "../output"
import type { ComponentCheckpoint, ComponentStateSchema, ComponentDefinition, ComponentMachine, ComponentDependencies, ComponentData, ComponentDataRequirements } from "../machine"
import { bindChild, type ChildOf, type ComponentChildren } from "./children"

// createMachine manages private snapshots and bound child lifecycles (children.test.ts).
export const createMachine = <State, View, Requirements, Result, Children extends ComponentChildren, Dependencies extends ComponentDependencies, Interactions>(
  definition: ComponentDefinition<State, View, Requirements, Result, Children, Dependencies, Interactions>,
  members: ReadonlyArray<Component<unknown, unknown>>,
  identities: ReadonlyArray<string>
): ComponentMachine<View, Requirements | ComponentDataRequirements<Dependencies>, Result, Interactions> => {
  const identity = definition.name
  const checkpoint = definition.checkpoint
  if (checkpoint !== undefined && members.some(member => machineOf(member).checkpoint === undefined)) {
    throw new Error(`Component "${identity}" requires checkpoint support from every child`)
  }
  const Binding = Schema.Struct({ position: Schema.Finite, at: Schema.Finite })
  type Binding = typeof Binding.Type
  const bind = (snapshots: ReadonlyArray<unknown>, binding: Binding = { position: 0, at: 0 }, data?: Context.Context<never>): ChildOf<Children> => {
    const handles = members.map((member, index) => bindChild(machineOf(member), snapshots[index], binding.position, binding.at, data))
    return (definition.children !== undefined && !Array.isArray(definition.children) ? handles[0] : Object.freeze(handles)) as ChildOf<Children>
  }
  type Snapshot = { readonly context: Context.Context<never>; readonly checkpoint: ComponentStateSchema<State> | undefined; readonly data: ComponentData<Dependencies>; readonly own: State; readonly binding: Binding; readonly children: ReadonlyArray<unknown>; readonly handles: ChildOf<Children>; readonly scopes: ReadonlySet<InteractionScope> }
  const initialize = (data = Context.empty(), restored?: { readonly encoded: ComponentCheckpoint }): Snapshot => {
    const inherited = Option.getOrElse(Context.getOption(data, SuppliedInteractions), () => new Set<InteractionScope>())
    const own = inputScopesOf(definition.input)
    const supplied = own.size === 0 ? inherited : new Set([...inherited, ...own])
    if (own.size > 0) data = Context.add(data, SuppliedInteractions, supplied)
    const childScopes = members.flatMap(member => [...inputScopesOf(member.input)])
    const scopes = childScopes.length === 0 ? supplied : new Set([...supplied, ...childScopes])
    if (restored !== undefined) {
      const children = restored.encoded.children ?? []
      if (children.length !== members.length || members.some((member, index) => children[index]?.component !== machineOf(member).checkpoint?.component)) {
        throw new Error(`Incompatible checkpoint children for component "${identity}"`)
      }
    }
    const children = members.map((member, index) => restored === undefined
      ? machineOf(member).initial(data)
      : machineOf(member).checkpoint!.decode(restored.encoded.children![index]!, data))
    const binding = restored === undefined || members.length === 0 ? { position: 0, at: 0 } : Schema.decodeUnknownSync(Binding)(restored.encoded.runtime)
    const handles = bind(children, binding, data)
    const codec = typeof checkpoint === "function" ? checkpoint(handles) : checkpoint
    if (codec !== undefined && codec.version.length === 0) throw new Error("Component checkpoints require a nonempty version")
    if (restored !== undefined && (restored.encoded.component !== identity || restored.encoded.version !== codec?.version)) throw new Error(`Incompatible checkpoint for component "${identity}"`)
    const dependencies = (definition.dependencies ?? []).map(key => Context.getUnsafe(data, key)) as ComponentData<Dependencies>
    return { context: data, checkpoint: codec, data: dependencies, own: restored === undefined ? definition.initial(handles, dependencies) : Schema.decodeSync(codec!.schema)(restored.encoded.state), children, binding, handles, scopes }
  }
  const machine: Projection<Snapshot, ComponentOutput<View, Requirements, Result, Interactions>> = {
    initial: initialize,
    step: (state, event) => {
      const children = members.map((member, index) => machineOf(member).step(state.children[index], event))
      const unchanged = children.every((child, index) => Object.is(child, state.children[index]))
      const binding = unchanged ? state.binding : { position: eventPositionOf(event) ?? 0, at: Number(event.at ?? 0) }
      const handles = unchanged ? state.handles : bind(children, binding, state.context)
      const own = definition.step(state.own, event, bindTransitionContext(event, identity, state.scopes), handles, state.handles)
      return Object.is(own, state.own) && unchanged ? state : { context: state.context, checkpoint: state.checkpoint, data: state.data, own, children, binding, handles, scopes: state.scopes }
    },
    output: (state) => {
      const output = definition.output(state.own, state.handles, state.data, { transition: event => bindTransitionContext(event, identity, state.scopes) })
      validateTransitions(output.transitions, identities)
      const cancel = output.interactions?.cancel
      return cancel === undefined ? output : {
        ...output,
        interactions: { ...output.interactions!, cancel: (cancellation: Parameters<typeof cancel>[0]) => validateTransitions(cancel(cancellation), identities) }
      }
    }
  }
  const projection = materializeProjection(machine)
  type CachedState = MaterializedProjectionState<Snapshot, ComponentOutput<View, Requirements, Result, Interactions>>
  return {
    ...(checkpoint === undefined ? {} : { checkpoint: {
      component: identity,
      encode: (state: unknown) => ({
        component: identity,
        version: (state as CachedState).state.checkpoint!.version,
        state: Schema.decodeSync(Schema.Json)(Schema.encodeSync((state as CachedState).state.checkpoint!.schema)((state as CachedState).state.own)),
        ...(members.length === 0 ? {} : {
          children: members.map((member, index) => machineOf(member).checkpoint!.encode((state as CachedState).state.children[index])),
          runtime: Schema.encodeSync(Binding)((state as CachedState).state.binding)
        })
      }),
      decode: (encoded: ComponentCheckpoint, data?: Context.Context<never>) => {
        const state = initialize(data, { encoded })
        return { state, value: machine.output(state) }
      }
    } }),
    initial: projection.initial,
    step: (state, event) => projection.step(state as CachedState, event),
    output: (state) => projection.output(state as CachedState)
  }
}
