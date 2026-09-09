/** Bounded cancellation, including disposal of results arriving after cancellation. */
export function visualOperation<T>(operation: Promise<T>, signal: AbortSignal, milliseconds: number,
  discard: (value: T) => void): Promise<T> {
  return new Promise((resolve, reject) => {
    let settled = false;
    const finish = (error: Error) => {
      if (settled) return; settled = true; clearTimeout(timer); signal.removeEventListener("abort", abort); reject(error);
    };
    const abort = () => finish(new Error("meet_visual_cancelled"));
    const timer = setTimeout(() => finish(new Error("meet_visual_operation_timeout")), milliseconds);
    signal.addEventListener("abort", abort, { once: true });
    operation.then(value => {
      if (settled) { try { discard(value); } catch { /* A cancelled result never becomes usable. */ } return; }
      settled = true; clearTimeout(timer); signal.removeEventListener("abort", abort); resolve(value);
    }, () => finish(new Error("meet_visual_operation_failed")));
    if (signal.aborted) abort();
  });
}
