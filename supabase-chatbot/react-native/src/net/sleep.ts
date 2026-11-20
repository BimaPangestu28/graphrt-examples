import { RequestCancelledError } from './errors.ts';

/**
 * Wait `delayMs`, or reject with RequestCancelledError as soon as `signal` aborts.
 *
 * @param delayMs - How long to wait (number)
 * @param signal - Optional cancellation (AbortSignal)
 * @returns Resolves after the delay (Promise<void>)
 */
export function sleep(delayMs: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(new RequestCancelledError());
      return;
    }
    const handleAbort = (): void => {
      clearTimeout(timer);
      reject(new RequestCancelledError());
    };
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', handleAbort);
      resolve();
    }, delayMs);
    signal?.addEventListener('abort', handleAbort, { once: true });
  });
}
