/** Capability only; keep the optional output parser outside the initial bundle. */
export function supportsSourceAudioOutput(capability: {
  capabilityVersion?: number; sourcePrograms?: boolean; sourceAudioControlVersion?: number; sourceAudioEncodingVersion?: number;
} | null | undefined): boolean {
  return capability?.capabilityVersion === 5 && capability.sourcePrograms === true
    && capability.sourceAudioControlVersion === 3 && capability.sourceAudioEncodingVersion === 1;
}
