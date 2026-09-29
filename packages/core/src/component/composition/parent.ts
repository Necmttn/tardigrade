import { ComponentCheckpoint } from "../checkpoint"
import { Context, Option, Schema } from "effect"
import { SuppliedInteractions, inputScopesOf, type InteractionScope } from "../../transition/interaction"
import { eventPositionOf } from "../../event"
import { machineOf } from "../runtime"
import { bindTransitionContext, validateTransitions } from "../../transition/transition"
import { materializeProjection, type MaterializedProjectionState } from "@clavia/tardigrade-core/projection"
import type { Component } from "../component"
import type { ComponentOutput } from "../output"
import type { ComponentDefinition, ComponentMachine, ComponentDependencies, ComponentData, ComponentDataRequirements } from "../machine"
import { bindChild, type ChildOf, type ComponentChildren } from "./children"

// createMachine manages private snapshots and bound child lifecycles (children.test.ts).
export const createMachine = <State, View, Requirements, Result, Children extends ComponentChildren, Dependencies extends ComponentDependencies, Interactions>(
  definition: ComponentDefinition<State, View, Requirements, Result, Children, Dependencies, Interactions>,
  members: ReadonlyArray<Component<unknown, unknown>>,
  identities: ReadonlyArray<string>
): ComponentMachine<View, Requirements | ComponentDataRequirements<Dependencies>, Result, Interactions> => {
  const identity = definition.name
  const machines = members.map(machineOf)
  const bind = (snapshots: ReadonlyArray<unknown>, binding: { readonly position: number; readonly at: number }): ChildOf<Children> => {
    const handles = machines.map((machine, index) => bindChild(machine, snapshots[index], binding.position, binding.at))
    return (definition.children !== undefined && !Array.isArray(definition.children) ? handles[0] : Object.freeze(handles)) as ChildOf<Children>
  }
  type Snapshot = { readonly binding: { readonly position: number; readonly at: number }; readonly own: State; readonly data: ComponentData<Dependencies>; readonly children: ReadonlyArray<unknown>; readonly handles: ChildOf<Children>; readonly scopes: ReadonlySet<InteractionScope> }
  const scopeContext = (data = Context.empty()) => {
    const inherited = Option.getOrElse(Context.getOption(data, SuppliedInteractions), () => new Set<InteractionScope>())
    const own = inputScopesOf(definition.input)
    const supplied = own.size === 0 ? inherited : new Set([...inherited, ...own])
    if (own.size > 0) data = Context.add(data, SuppliedInteractions, supplied)
    const childScopes = members.flatMap(member => [...inputScopesOf(member.input)])
    return { data, bindings: (definition.dependencies ?? []).map(key => Context.getUnsafe(data, key)) as ComponentData<Dependencies>, scopes: childScopes.length === 0 ? supplied : new Set([...supplied, ...childScopes]) }
  }
  const output = (state: Snapshot): ComponentOutput<View, Requirements, Result, Interactions> => {
    const output = definition.output(state.own, state.handles, state.data, { transition: event => bindTransitionContext(event, identity, state.scopes) })
    validateTransitions(output.transitions, identities)
    const cancel = output.interactions?.cancel
    return cancel === undefined ? output : {
      ...output,
      interactions: { ...output.interactions!, cancel: (cancellation: Parameters<typeof cancel>[0]) => validateTransitions(cancel(cancellation), identities) }
    }
  }
  const projection = materializeProjection<Snapshot, ComponentOutput<View, Requirements, Result, Interactions>>({
    initial: (context) => {
      const { data, bindings, scopes } = scopeContext(context)
      const children = machines.map(machine => machine.initial(data))
      const binding = { position: 0, at: 0 }
      const handles = bind(children, binding)
      return { own: definition.initial(handles, bindings), data: bindings, children, handles, scopes, binding }
    },
    step: (state, event) => {
      const children = machines.map((machine, index) => machine.step(state.children[index], event))
      const unchanged = children.every((child, index) => Object.is(child, state.children[index]))
      const binding = unchanged ? state.binding : { position: eventPositionOf(event) ?? 0, at: Number(event.at ?? 0) }
      const handles = unchanged ? state.handles : bind(children, binding)
      const own = definition.step(state.own, event, bindTransitionContext(event, identity, state.scopes), handles, state.handles)
      return Object.is(own, state.own) && unchanged ? state : { own, children, handles, data: state.data, scopes: state.scopes, binding }
    },
    output
  })
  type CachedState = MaterializedProjectionState<Snapshot, ComponentOutput<View, Requirements, Result, Interactions>>
  const checkpoint = machines.every(machine => machine.checkpoint !== undefined) ? definition.state : undefined
  return {
    ...(checkpoint === undefined ? {} : { checkpoint: {
      encode: (snapshot: unknown): ComponentCheckpoint => ({
        component: identity, version: checkpoint.version,
        state: Schema.encodeSync(checkpoint.schema)((snapshot as CachedState).state.own),
        children: machines.map((machine, index) => machine.checkpoint!.encode((snapshot as CachedState).state.children[index])),
        ...(members.length === 0 ? {} : { binding: (snapshot as CachedState).state.binding })
      }),
      decode: (candidate: unknown, data?: Context.Context<never>): CachedState => {
        const saved = Schema.decodeUnknownSync(ComponentCheckpoint)(candidate)
        if (saved.component !== identity || saved.version !== checkpoint.version) throw new Error(`Incompatible checkpoint for component "${identity}"`)
        if (saved.children.length !== machines.length) throw new Error(`Checkpoint child count differs for component "${identity}"`)
        if (machines.length > 0 && saved.binding === undefined) throw new Error(`Checkpoint is missing child binding coordinates for component "${identity}"`)
        const runtime = scopeContext(data)
        const own = Schema.decodeSync(checkpoint.schema)(saved.state)
        const children = machines.map((machine, index) => machine.checkpoint!.decode(saved.children[index], runtime.data))
        const binding = saved.binding ?? { position: 0, at: 0 }
        const state: Snapshot = {
          own, children, binding, data: runtime.bindings, scopes: runtime.scopes, handles: bind(children, binding)
        }
        return { state, value: output(state) }
      }
    } }),
    initial: projection.initial,
    step: (state, event) => projection.step(state as CachedState, event),
    output: (state) => projection.output(state as CachedState)
  }
}
