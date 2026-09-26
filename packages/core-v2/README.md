# Context-dependent dynamical systems

This mathematical specification follows [Spivak, *Functorial Dynamics and Interaction*, §§1.1, 1.4, 2](https://dspivak.net/grants/AFOSR2020-Topos-ContextDependence.pdf). Write `T(p)` for the interactions available at position `p`. Here `Σ` denotes a dependent sum, `Π` a product, and `Xᴱ` the set of functions from `E` to `X`.

## Arena

An arena consists of a set of positions `P` and a family of interaction sets `T : P → Set`. Its polynomial functor is

```text
A(X) = Σ[p ∈ P] Xᵀ⁽ᵖ⁾
```

## Model

A model `f : A → B`, with `B = (Q, U)`, consists of

```text
f₊  : P → Q
f⁻[p] : U(f₊(p)) → T(p)
```

Positions map forward; interactions map backward. For `g : B → C`,

```text
(g ∘ f)₊  = g₊ ∘ f₊
(g ∘ f)⁻[p] = f⁻[p] ∘ g⁻[f₊(p)]
```

Identity models have identity maps in both directions. These objects and models form the category `Poly`.

## Dynamics

For a state set `S`, define the self-referencer

```text
Self(S)(X) = S × Xˢ
```

A dynamical system with interface `A` is a model

```text
d : Self(S) → A
```

Equivalently, it consists of

```text
v : S → P
u : Σ[s ∈ S] T(v(s)) → S
```

Here `v` is the public view and `u` the transition function. An initialized system additionally chooses `s₀ ∈ S`:

```text
pₙ     = v(sₙ)
aₙ     ∈ T(pₙ)
sₙ₊₁   = u(sₙ, aₙ)
```

## Parallel composition

The Dirichlet tensor combines interfaces:

```text
(A ⊗ B)(X) = Σ[(p, q) ∈ P × Q] X^(T(p) × U(q))
```

Systems `dᵢ : Self(Sᵢ) → Aᵢ` consequently combine as

```text
⊗ᵢ dᵢ : Self(Πᵢ Sᵢ) → ⊗ᵢ Aᵢ
```

## Wiring

A wiring model `w : ⊗ᵢ Aᵢ → B` determines the composite system `w ∘ (⊗ᵢ dᵢ)`. For joint state `s = (sᵢ)ᵢ`, let `p = (vᵢ(sᵢ))ᵢ`. Then

```text
v(s)    = w₊(p)
a       = w⁻ₚ(b)
u(s, b) = (uᵢ(sᵢ, aᵢ))ᵢ
```

Here `b ∈ U(w₊(p))` and `aᵢ ∈ Tᵢ(pᵢ)`. Wiring may depend on the joint public position `p`. Each machine updates from its own state and supplied interaction.

For the closed interface `𝕪 = ({*}, * ↦ {*})`, wiring supplies `w⁻ₚ(*)`, giving autonomous evolution. Model composition is associative and unital; tensor composition is associative, unital, and symmetric up to the corresponding canonical isomorphisms.

## Implementation correspondence

The [code guide](./GUIDE.md) covers the TypeScript API with examples.

The following mapping relates the mathematical definitions to the current implementation. The equations above specify the mathematical model; this correspondence does not establish that the implementation satisfies every law of `Poly`.

| Mathematical object | Implementation | Meaning |
| --- | --- | --- |
| State set `S` | [`Machine<State, Position, Interaction>`](./src/machine.ts), parameter `State` | Internal information retained by a machine. |
| Position set `P` | `Position` | The complete observable value, including its data fields. |
| Initial state `s₀` | `initial` | A chosen element of `State`. |
| Public view `v : S → P` | `view(state)` | Computes the public position from internal state. |
| Interaction family `T(p)` | [`interface.interactions(position)`](./src/interactions.ts) and `Interaction[ModeOf<Position>]` | Runtime schemas describe admitted payloads; static transition types are indexed by position tag. |
| Transition `u(s, a)` | `transitions[mode][interactionName](state, interaction)` | Updates the receiving machine's state. |
| Joint state `Πᵢ Sᵢ` | [`States<M>`](./src/compose.ts) | A record of child states indexed by machine name. |
| Joint position `(vᵢ(sᵢ))ᵢ` | `compose(...).view(state).children` | A record of child public positions. |
| Supplied local interactions `(aᵢ)ᵢ` | `Delivery<M>` | At most one interaction per child in a delivery; omitted children retain their states. |
| Joint update `(uᵢ(sᵢ, aᵢ))ᵢ` | `deliver(state, delivery)` | Applies delivered interactions against the same input snapshot. |

### Ports and wiring

[Ports](./src/ports.ts) provide the concrete connection mechanism. `interaction<Payload>(name)` creates a shared token. `output(token, read)` extracts a payload from a public position; `input(token, receive)` translates that payload into a local interaction. Connections require the same token identity. Matching payload types alone do not connect ports.

[Composition](./src/compose.ts) constructs routes, then performs:

```text
pᵢ          = machineᵢ.view(sᵢ)
payloadᵢ    = outputᵢ.read(pᵢ)
aⱼ          = inputⱼ.receive(sⱼ, payloadᵢ)
s′          = deliver(s, wire(s))
```

An inactive output returns `undefined` and supplies no interaction. When several inputs reach one child, its `combine(state, interactions)` function constructs the interaction to deliver. `step(state)` performs one wiring-and-transition round.

This routing resembles the backward part of a wiring model. It has additional freedoms: `receive` and `combine` can inspect internal state. A mathematical wiring map `w⁻ₚ` depends on public positions and the external interaction. To identify a routing implementation with such a map, its behavior must factor through those public positions. That restriction is not enforced by the port types.

The composed view retains all child positions under `{ position: "composed", children }`. Outer output ports can select information from that view, but the package does not define a general `Model<A, B>` abstraction implementing both maps of an arbitrary arena morphism.

Public position values are described by `interface.view`, an Effect Schema. The function `view(state)` computes a value of that schema's decoded type. The schema and interaction family form the public contract; state and transition functions belong to its implementation.

### Position-dependent interactions

The transition-table type uses a mode function `m : P → Modes` and a mode-indexed interaction family `I`:

```text
T(p) = I(m(p))
```

For an object position, `m(p)` is its `position` field. Static transition types share an interaction family for a tag. Runtime interaction schemas can further restrict that family using the complete position. The mathematical definition permits a family that depends on the entire position.

`deliver` checks the current interaction schema, payload, tag, and transition name at runtime. The routes are fixed at construction; position-dependent output activation changes which routes carry information. Neither these checks nor nested composition establish the general identity, associativity, or symmetry laws stated above.

### Projections and effects

[Projections](./src/projection.ts) and [effects](./src/effects.ts) are additional implementation structures. For an event set `E`, a supplied projection has the form `πᵢ : E* → Sᵢ`. Assuming convergence under the chosen state equality, `fromLog` computes

```text
q(L) = (πᵢ(L))ᵢ
s₀ = q(L)
sₙ₊₁ = step(sₙ)
s(L) = sₙ₊₁ at the first n for which sₙ₊₁ ≈ sₙ
```

A child without a projection contributes its `initial` state to `q(L)`. Each append reconstructs state from the extended log. This is a specified reconstruction procedure; it does not assert a fold law relating a projection to the machine's transition function.

`effects(position)` exposes deferred requests and Effect programs. Composition collects them in sibling order, and `firstEffect` selects the first available item. Their execution and result recording require a host. Modeling that host and its services as interacting dynamical systems requires a further construction beyond the correspondence above.
