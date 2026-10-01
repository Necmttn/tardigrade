import { expect, test } from "bun:test"
import * as root from "tardie"
import * as core from "tardie/core"
import * as agent from "tardie/agent"
import * as deprecated from "tardie/deprecated"
import * as components from "tardie/deprecated/core"

test("public scopes expose atoms and separate deprecated components", () => {
  expect(root.durableAtom).toBe(core.durableAtom)
  expect(root.infer).toBe(agent.infer)
  expect(root.defineActor).toBe(core.defineActor)
  expect(deprecated.defineActor).toBe(components.defineActor)
  expect(root.defineActor).not.toBe(deprecated.defineActor)
  expect("legacyComponent" in root).toBe(false)
})
