/** Cancel a browser audio setup operation without waiting for its Promise. */
export async function untilAudioAbort<T>(operation: Promise<T>, signal: AbortSignal): Promise<T> {
  signal.throwIfAborted();
  let stop: () => void = () => {};
  try {
    return await Promise.race([operation, new Promise<never>((_, reject) => {
      stop = () => reject(new Error("meet_audio_cancelled")); signal.addEventListener("abort", stop, { once: true });
    })]);
  } finally { signal.removeEventListener("abort", stop); }
}
