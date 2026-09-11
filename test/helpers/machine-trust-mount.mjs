import assert from "node:assert/strict";

// Older compose-go marshals false with omitempty. This is NOT a YAML default:
// require the explicit source policy independently before accepting that JSON.
export function assertMachineTrustMount(source, rendered, directory) {
  const fields = { type: "bind", target: "/run/machine-trust", read_only: true };
  assert.deepEqual(source, { ...fields,
    source: "${MACHINE_HUB_TRUST_PROFILE_DIRECTORY:?Operator-owned public trust directory required}",
    bind: { create_host_path: false } });
  assert.ok(rendered?.bind && typeof rendered.bind === "object" && !Array.isArray(rendered.bind));
  assert.ok(Object.keys(rendered.bind).length === 0
    || (Object.keys(rendered.bind).length === 1 && rendered.bind.create_host_path === false));
  assert.deepEqual(rendered, { ...fields, source: directory, bind: rendered.bind });
}
