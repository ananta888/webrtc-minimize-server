import { describe, expect, it } from "vitest";
import { machineReceiveFeedback } from "./machine-receive-feedback";

describe("closed machine permission feedback", () => {
  it("does not show feedback in the absence of an error", () => expect(machineReceiveFeedback("")).toBeNull());
  it.each(["ack_timeout", "request_failed"])("does not claim rollback or an automatic retry after %s", reason => {
    const value = machineReceiveFeedback("machine_receive_" + reason)!;
    expect(value.message).toContain("Prüfe");
    expect(value.message).not.toMatch(/nichts freigegeben|zurückgesetzt|automatisch wiederholt/);
    expect(value.diagnostic).toBe("machine_receive_" + reason);
  });
  it.each(["selection_changed", "hub_capability_missing", "actor_denied", "scope_denied", "subscription_denied",
    "revision_conflict", "session_changed", "source_not_active", "target_unavailable", "selection_invalid",
    "consent_invalid", "config_invalid", "policy_invalid"])("explains %s using fixed actionable text", reason => {
    const code = "machine_receive_" + reason, value = machineReceiveFeedback(code)!;
    expect(value.title.length).toBeGreaterThan(5); expect(value.message.length).toBeGreaterThan(30);
    expect(value.message).not.toContain(code); expect(value.diagnostic).toBe(code); expect(Object.isFrozen(value)).toBe(true);
  });
  it.each(["constructor", "__proto__", "machine_receive_secret_token", "<img src=x onerror=alert(1)>", null, {}, 5])(
    "never echoes unknown diagnostics: %j", code => {
      const value = machineReceiveFeedback(code)!;
      expect(value.diagnostic).toBeNull(); expect(value.title).toBe("Aktion nicht bestätigt");
      if (typeof code === "string") expect(JSON.stringify(value)).not.toContain(code);
    });
});
