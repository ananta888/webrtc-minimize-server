export type PlaybackWait<T> =
  | { readonly state: "fulfilled"; readonly value: T }
  | { readonly state: "failed" | "timeout" | "aborted" };

// Observe an owned operation without exposing adapter exceptions. Timing out
// does not assert that the underlying transport has stopped: its owner must
// still abort and clean up a late result before another transport may open.
export function boundedPlaybackWait<T>(
  operation: Promise<T>, budgetMs: number, signal?: AbortSignal,
): Promise<PlaybackWait<T>> {
  const deadline = performance.now() + Math.max(0, budgetMs);
  return new Promise((resolve) => {
    let settled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const finish = (result: PlaybackWait<T>) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal?.removeEventListener("abort", abort);
      resolve(result);
    };
    const abort = () => finish({ state: "aborted" });
    const complete = (result: PlaybackWait<T>) => finish(signal?.aborted
      ? { state: "aborted" }
      : performance.now() >= deadline ? { state: "timeout" } : result);
    operation.then((value) => complete({ state: "fulfilled", value }),
      () => complete({ state: "failed" }));
    signal?.addEventListener("abort", abort, { once: true });
    if (signal?.aborted) abort();
    else timer = setTimeout(() => finish({ state: "timeout" }), Math.max(0, budgetMs));
  });
}
