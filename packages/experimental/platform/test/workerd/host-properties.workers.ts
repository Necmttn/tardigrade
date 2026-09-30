import { test } from "vitest"
import * as fc from "fast-check"
import { HOST_PROPERTY_OPTIONS } from "../../../host/properties/config"
import { promiseSettlementOrder } from "../../../host/properties/promise-settlement-order"
import { referenceAcceptanceAtomicity } from "../../../host/properties/reference-acceptance-atomicity"
import { ownedProducerRecovery, externalProducerObservation } from "../../../host/properties/deferred-recovery"

import { toolDeferredLifecycle } from "../properties/tool-deferred-lifecycle"

test("promiseSettlementOrder", () => fc.assert(promiseSettlementOrder, HOST_PROPERTY_OPTIONS))
test("referenceAcceptanceAtomicity", () => fc.assert(referenceAcceptanceAtomicity, HOST_PROPERTY_OPTIONS))
test("ownedProducerRecovery", () => fc.assert(ownedProducerRecovery, HOST_PROPERTY_OPTIONS))
test("externalProducerObservation", () => fc.assert(externalProducerObservation, HOST_PROPERTY_OPTIONS))

test("toolDeferredLifecycle", () => fc.assert(toolDeferredLifecycle, HOST_PROPERTY_OPTIONS))
