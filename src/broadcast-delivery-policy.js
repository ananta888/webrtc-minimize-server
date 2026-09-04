export class BroadcastDeliveryPolicyError extends Error {
  constructor(code) {
    super(code);
    this.name = "BroadcastDeliveryPolicyError";
    this.code = code;
  }
}

function fail(code) { throw new BroadcastDeliveryPolicyError(code); }

export function evaluateBroadcastDelivery(input) {
  const fields = new Set(["mode", "videoCodec", "audioCodec", "encodingCount", "simulcastNegotiated", "gatewayTranscodes"]);
  if (!input || typeof input !== "object" || Array.isArray(input)
    || Object.keys(input).length !== fields.size || Object.keys(input).some((key) => !fields.has(key))
    || !new Set(["browser-single-whip", "browser-simulcast-whip", "gateway-passthrough", "native-abr"]).has(input.mode)
    || !new Set(["vp8", "vp9", "h264", "av1"]).has(input.videoCodec)
    || !new Set(["opus", "aac"]).has(input.audioCodec)
    || !Number.isSafeInteger(input.encodingCount) || input.encodingCount < 1 || input.encodingCount > 3
    || typeof input.simulcastNegotiated !== "boolean" || typeof input.gatewayTranscodes !== "boolean") {
    fail("invalid_broadcast_delivery_input");
  }
  if (input.mode === "browser-single-whip" && input.encodingCount !== 1) fail("single_whip_has_one_encoding");
  if (input.mode === "browser-simulcast-whip" && (!input.simulcastNegotiated || input.encodingCount < 2)) {
    fail("browser_simulcast_not_negotiated");
  }
  if ((input.mode === "gateway-passthrough" || input.mode.startsWith("browser-")) && input.gatewayTranscodes) {
    fail("gateway_transcoding_not_supported");
  }
  const broadHlsCompatible = input.videoCodec === "h264" && input.audioCodec === "aac";
  const adaptiveBitrate = input.mode === "native-abr" && input.encodingCount > 1 && broadHlsCompatible;
  return Object.freeze({
    mode: input.mode,
    broadHlsCompatible,
    adaptiveBitrate,
    independentlySelectableRenditions: adaptiveBitrate ? input.encodingCount : 1,
    reason: adaptiveBitrate
      ? "native_h264_aac_renditions"
      : broadHlsCompatible
        ? "single_gateway_passthrough"
        : "trusted_transcode_required",
  });
}
