export interface BackgroundProgress {
  phase: 'download' | 'prepare' | 'process' | 'finish';
  loaded?: number;
  total?: number;
  percent?: number;
}

export interface BackgroundOptions {
  onProgress?: (progress: BackgroundProgress) => void;
  signal?: AbortSignal;
}

export type BackgroundWorkerMessage =
  | { type: 'progress'; progress: BackgroundProgress }
  | { type: 'result'; blob: Blob }
  | { type: 'error'; message: string };

/** Runs only on request. Terminating the dedicated worker also cancels inference. */
export function removeBackgroundAi(input: Blob, options: BackgroundOptions = {}): Promise<Blob> {
  return new Promise((resolve, reject) => {
    if (options.signal?.aborted) {
      reject(new DOMException('Background removal cancelled', 'AbortError'));
      return;
    }
    if (typeof Worker === 'undefined' || typeof OffscreenCanvas === 'undefined') {
      reject(new Error('BACKGROUND_BROWSER_UNSUPPORTED'));
      return;
    }

    const worker = new Worker(new URL('./ai.worker.ts', import.meta.url), { type: 'module' });
    const cleanup = () => {
      options.signal?.removeEventListener('abort', abort);
      worker.terminate();
    };
    const abort = () => {
      cleanup();
      reject(new DOMException('Background removal cancelled', 'AbortError'));
    };
    options.signal?.addEventListener('abort', abort, { once: true });
    worker.onmessage = ({ data }: MessageEvent<BackgroundWorkerMessage>) => {
      if (data.type === 'progress') options.onProgress?.(data.progress);
      else {
        cleanup();
        if (data.type === 'result') resolve(data.blob);
        else reject(new Error(data.message));
      }
    };
    worker.onerror = (event) => {
      cleanup();
      reject(new Error(event.message || 'BACKGROUND_WORKER_FAILED'));
    };
    worker.onmessageerror = () => {
      cleanup();
      reject(new Error('BACKGROUND_WORKER_FAILED'));
    };
    worker.postMessage({ input });
  });
}
