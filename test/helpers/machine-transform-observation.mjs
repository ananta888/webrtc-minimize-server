// Read-only private test diagnostics. This function also runs inside a browser.
export function transformFailureCounts(values = globalThis.__transformErrors) {
  const counts = {
    media_frame_type: 0,
    media_codec_unsupported: 0,
    media_frame_too_short: 0,
    media_envelope_version: 0,
    media_key_budget_exhausted: 0,
    worker_load_or_runtime_error: 0,
    unknown: 0,
  };
  if (!Array.isArray(values)) return { valid: false, inspected: 0, truncated: false, counts };
  const inspected = Math.min(values.length, 128);
  for (let i = 0; i < inspected; i++) {
    const code = values[i];
    if (typeof code === "string" && Object.hasOwn(counts, code)) counts[code]++;
    else counts.unknown++;
  }
  return { valid: true, inspected, truncated: values.length > inspected, counts };
}
