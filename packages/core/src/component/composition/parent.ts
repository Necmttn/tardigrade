import { ComponentCheckpoint } from "../checkpoint"
import { Context, Option, Schema } from "effect"
import { SuppliedInteractions, inputScopesOf, type InteractionScope } from "../../transition/interaction"
import { eventPositionOf, type Event } from "../../event"
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
  const bind = (snapshots: ReadonlyArray<unknown>, event?: Event): ChildOf<Children> => {
    const handles = members.map((member, index) => bindChild(machineOf(member), snapshots[index], event === undefined ? 0 : eventPositionOf(event) ?? 0, Number(event?.at ?? 0)))
    return (definition.children !== undefined && !Array.isArray(definition.children) ? handles[0] : Object.freeze(handles)) as ChildOf<Children>
  }
  type Snapshot = { readonly own: State; readonly data: ComponentData<Dependencies>; readonly children: ReadonlyArray<unknown>; readonly handles: ChildOf<Children>; readonly scopes: ReadonlySet<InteractionScope> }
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
      const children = members.map((member) => machineOf(member).initial(data))
      const handles = bind(children)
      return { own: definition.initial(handles, bindings), data: bindings, children, handles, scopes }
    },
    step: (state, event) => {
      const children = members.map((member, index) => machineOf(member).step(state.children[index], event))
      const unchanged = children.every((child, index) => Object.is(child, state.children[index]))
      const handles = unchanged ? state.handles : bind(children, event)
      const own = definition.step(state.own, event, bindTransitionContext(event, identity, state.scopes), handles, state.handles)
      return Object.is(own, state.own) && unchanged ? state : { own, children, handles, data: state.data, scopes: state.scopes }
    },
    output
  })
  type CachedState = MaterializedProjectionState<Snapshot, ComponentOutput<View, Requirements, Result, Interactions>>
  const checkpoint = members.length === 0 ? definition.state : undefined
  return {
    ...(checkpoint === undefined ? {} : { checkpoint: {
      encode: (snapshot: unknown): ComponentCheckpoint => ({
        component: identity, version: checkpoint.version,
        state: Schema.encodeSync(checkpoint.schema)((snapshot as CachedState).state.own)
      }),
      decode: (candidate: unknown, data?: Context.Context<never>): CachedState => {
        const saved = Schema.decodeUnknownSync(ComponentCheckpoint)(candidate)
        if (saved.component !== identity || saved.version !== checkpoint.version) throw new Error(`Incompatible checkpoint for component "${identity}"`)
        const { bindings, scopes } = scopeContext(data)
        const state: Snapshot = {
          data: bindings,
          own: Schema.decodeSync(checkpoint.schema)(saved.state), children: [], handles: bind([]), scopes
        }
        return { state, value: output(state) }
      }
    } }),
    initial: projection.initial,
    step: (state, event) => projection.step(state as CachedState, event),
    output: (state) => projection.output(state as CachedState)
  }
}
