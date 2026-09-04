export const MOQ_UI_CAPABILITY_STATUS = Object.freeze({
  enabled: false,
  status: "unavailable" as const,
  label: "MoQ (experimentell): deaktiviert",
  transportVersion: "draft-ietf-moq-transport-20",
  locVersion: "draft-ietf-moq-loc-04",
  webTransportVersion: "RFC 9297",
  secureObjectsVersion: "draft-ietf-moq-secure-objects-01",
  fallback: "LL-HLS/HLS",
  browsers: "WebTransport vorhanden; MoQ-Interoperabilität noch nicht verifiziert",
  mediaMtx: "1.20.1 bevorzugt MOQT draft-19 und ist inkompatibel",
  cloudflare: "Beta dokumentiert draft-14/draft-16 und ist inkompatibel",
  secureObjects: "nur isolierter Prototyp; nicht integriert und nicht als Broadcast-E2EE freigegeben",
});

export type MoqUiCapabilityStatus = typeof MOQ_UI_CAPABILITY_STATUS;
