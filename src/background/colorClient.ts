import type { RGB } from './color';

export interface SolidBackgroundOptions {
  color?: RGB;
  tolerance?: number;
  softness?: number;
  contiguous?: boolean;
  signal?: AbortSignal;
}

/** Keep full-resolution flood filling and encoding off the interface thread. */
export function removeSolidBackground(input: Blob, options: SolidBackgroundOptions = {}): Promise<Blob> {
  return new Promise((resolve, reject) => {
    if (options.signal?.aborted) { reject(new DOMException('Cancelled', 'AbortError')); return; }
    const worker = new Worker(new URL('./color.worker.ts', import.meta.url), { type: 'module' });
    let finished = false;
    const cleanup = () => { worker.terminate(); options.signal?.removeEventListener('abort', cancel); };
    const fail = (error: Error) => {
      if (finished) return;
      finished = true;
      cleanup();
      reject(error);
    };
    const cancel = () => fail(new DOMException('Cancelled', 'AbortError'));
    options.signal?.addEventListener('abort', cancel, { once: true });
    worker.onerror = () => fail(new Error('Background processing is not available in this browser.'));
    worker.onmessage = (event: MessageEvent<{ blob?: Blob; error?: string }>) => {
      if (finished) return;
      if (event.data.error || !event.data.blob) {
        fail(new Error(event.data.error || 'Background processing failed.'));
        return;
      }
      finished = true;
      cleanup();
      resolve(event.data.blob);
    };
    const { signal: _signal, ...settings } = options;
    try { worker.postMessage({ input, options: settings }); }
    catch (error) { fail(error instanceof Error ? error : new Error('Unable to start processing.')); }
  });
}
