import { expect, test } from "bun:test"
import * as root from "tardie"
import * as core from "tardie/core"
import * as agent from "tardie/agent"
import * as v1 from "tardie/v1"
import * as v2 from "tardie/v2"
import * as atomCore from "tardie/v2/core"
import * as atomAgent from "tardie/v2/agent"

test("public scopes preserve legacy defaults and separate API generations", () => {
  expect(root.defineActor).toBe(core.defineActor)
  expect(root.defineActor).toBe(v1.defineActor)
  expect(root.infer).toBe(agent.infer)
  expect(v2.defineActor).toBe(atomCore.defineActor)
  expect(v2.durableAtom).toBe(atomCore.durableAtom)
  expect(v2.infer).toBe(atomAgent.infer)
  expect(root.defineActor).not.toBe(v2.defineActor)
  expect("legacyComponent" in root).toBe(true)
})
