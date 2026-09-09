import { describe, expect, it } from "vitest";
import { machineIntegrationStatus } from "../../../../../src/machine-integration-status.js";
import { MACHINE_INTEGRATION_CAPABILITIES, parseMachineIntegration } from "./machine-integration-status";

describe("closed integration observation", () => {
  const fixture = () => machineIntegrationStatus(true, ["chat.read"]);
  it("consumes the real server projection with immutable independently owned lists", () => {
    const input = JSON.parse(JSON.stringify(fixture())), result = parseMachineIntegration(input);
    expect(result.supportedCapabilities).toEqual(MACHINE_INTEGRATION_CAPABILITIES);
    input.operatorCapabilityCeiling.push("screen.publish");
    expect(result.operatorCapabilityCeiling).toEqual(["chat.read"]);
    expect(Object.isFrozen(result)).toBe(true);
    for (const list of [result.supportedCapabilities, result.operatorCapabilityCeiling, result.publisherConsentRequired]) {
      expect(Object.isFrozen(list)).toBe(true);
    }
  });
  it("accepts a disabled admission independently of a configured ceiling", () => {
    for (const ceiling of [[], ["chat.read"]]) {
      expect(parseMachineIntegration(machineIntegrationStatus(false, ceiling)).admissionEnabled).toBe(false);
    }
  });
  it("rejects unknown/missing fields and incompatible versions without legacy fallback", () => {
    for (const key of Object.keys(fixture())) {
      const missing = { ...fixture() }; delete missing[key];
      expect(() => parseMachineIntegration(missing)).toThrow("machine_integration_invalid");
      expect(() => parseMachineIntegration({ ...fixture(), [key]: null })).toThrow();
    }
    for (const value of [null, [], true, { ...fixture(), hubConnected: true }, { ...fixture(), schema: "ananta.meet-capabilities.v1" },
      { ...fixture(), admissionEnabled: "true" }, { ...fixture(), sessionLease: "v2" }]) {
      expect(() => parseMachineIntegration(value)).toThrow();
    }
  });
  it("rejects unsupported, duplicate, unsorted, oversized or authority-like capability lists", () => {
    for (const field of ["supportedCapabilities", "operatorCapabilityCeiling", "publisherConsentRequired"]) {
      for (const bad of [["record"], ["chat.read", "chat.read"], ["chat.send", "chat.read"], Array(9).fill("chat.read"),
        [null], [true], ["__proto__"], {}, "chat.read"]) {
        expect(() => parseMachineIntegration({ ...fixture(), [field]: bad })).toThrow();
      }
    }
    for (const change of [{ supportedCapabilities: ["chat.read"] }, { publisherConsentRequired: [] }, { operatorCapabilityCeiling: [] }]) {
      expect(() => parseMachineIntegration({ ...fixture(), ...change })).toThrow();
    }
  });
});
