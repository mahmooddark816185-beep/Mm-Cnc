import * as ort from 'onnxruntime-web/wasm';
import wasmUrl from '../../node_modules/onnxruntime-web/dist/ort-wasm-simd-threaded.wasm?url';
import moduleUrl from '../../node_modules/onnxruntime-web/dist/ort-wasm-simd-threaded.mjs?url';
import type { BackgroundProgress, BackgroundWorkerMessage } from './ai';

// U²-Net (Apache-2.0), the full general-purpose model, pinned to an immutable revision.
// This ONNX file is byte-for-byte the rembg v0.0.0 u2net.onnx (see README.md).
const MODEL_URL = 'https://huggingface.co/jellybox/u2net/resolve/b8b2ea0e632dadabd925c166c39b8f06be0a5031/u2net_320.onnx';
const MODEL_BYTES = 175_997_641;
const MODEL_SHA256 = '8d10d2f3bb75ae3b6d527c77944fc5e7dcd94b29809d47a739a7a728a912b491';
const CACHE_NAME = 'mm-cnc-background-u2net-v1';
const SIZE = 320;

const scope = globalThis as unknown as {
  postMessage(message: BackgroundWorkerMessage): void;
  onmessage: ((event: MessageEvent<{ input: Blob }>) => void) | null;
};

function progress(value: BackgroundProgress) {
  scope.postMessage({ type: 'progress', progress: value });
}

async function verifyModel(buffer: ArrayBuffer) {
  if (buffer.byteLength !== MODEL_BYTES) throw new Error('BACKGROUND_MODEL_INCOMPLETE');
  const digest = await crypto.subtle.digest('SHA-256', buffer);
  const hex = Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, '0')).join('');
  if (hex !== MODEL_SHA256) throw new Error('BACKGROUND_MODEL_INVALID');
}

async function loadModel(): Promise<ArrayBuffer> {
  progress({ phase: 'download', loaded: 0, total: MODEL_BYTES, percent: 0 });
  let cache: Cache | undefined;
  try {
    cache = await caches.open(CACHE_NAME);
    const saved = await cache.match(MODEL_URL);
    if (saved) {
      const buffer = await saved.arrayBuffer();
      try {
        await verifyModel(buffer);
        progress({ phase: 'download', loaded: MODEL_BYTES, total: MODEL_BYTES, percent: 100 });
        return buffer;
      } catch {
        await cache.delete(MODEL_URL);
      }
    }
  } catch {
    // Private browsing and storage limits must not prevent processing.
  }
  const bytes = new Uint8Array(MODEL_BYTES);
  let loaded = 0;
  let reported = -1;
  const chunkSize = 8 * 1024 * 1024;
  let nextStart = 0;
  async function downloadParts() {
    while (nextStart < MODEL_BYTES) {
      const start = nextStart;
      nextStart += chunkSize;
      const end = Math.min(MODEL_BYTES - 1, start + chunkSize - 1);
      let offset = start;
      // Resume a failed segment without restarting a 176 MB download.
      for (let attempt = 0; offset <= end && attempt < 4; attempt++) {
        let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
        try {
          const response = await fetch(MODEL_URL, {
            credentials: 'omit',
            headers: { Range: `bytes=${offset}-${end}` },
          });
          if (response.status !== 206 || !response.body ||
              response.headers.get('Content-Range') !== `bytes ${offset}-${end}/${MODEL_BYTES}`) {
            throw new Error('BACKGROUND_MODEL_DOWNLOAD_FAILED');
          }
          reader = response.body.getReader();
          while (true) {
            const { done, value } = await reader.read();
            if (done) break;
            if (offset + value.length > end + 1) throw new Error('BACKGROUND_MODEL_INVALID');
            bytes.set(value, offset);
            offset += value.length;
            loaded += value.length;
            const percent = Math.floor(loaded * 100 / MODEL_BYTES);
            if (percent !== reported) {
              reported = percent;
              progress({ phase: 'download', loaded, total: MODEL_BYTES, percent });
            }
          }
        } catch {
          await reader?.cancel().catch(() => undefined);
          if (attempt === 3) throw new Error('BACKGROUND_MODEL_DOWNLOAD_FAILED');
        }
      }
      if (offset !== end + 1) throw new Error('BACKGROUND_MODEL_INCOMPLETE');
    }
  }
  await Promise.all(Array.from({ length: 4 }, () => downloadParts()));
  await verifyModel(bytes.buffer);
  try {
    await cache?.put(MODEL_URL, new Response(bytes, { headers: { 'Content-Type': 'application/octet-stream' } }));
  } catch {
    // The result remains usable when the browser cannot persist a large model.
  }
  return bytes.buffer;
}

function canvas(width: number, height: number) {
  const surface = new OffscreenCanvas(width, height);
  const context = surface.getContext('2d', { willReadFrequently: true });
  if (!context) throw new Error('BACKGROUND_BROWSER_UNSUPPORTED');
  return { surface, context };
}

function inputTensor(bitmap: ImageBitmap) {
  const { context } = canvas(SIZE, SIZE);
  context.fillStyle = '#ffffff';
  context.fillRect(0, 0, SIZE, SIZE);
  context.imageSmoothingQuality = 'high';
  context.drawImage(bitmap, 0, 0, SIZE, SIZE);
  const rgba = context.getImageData(0, 0, SIZE, SIZE).data;
  // Match the original U²-Net/rembg RGB normalization, including the image maximum.
  let maximum = 1;
  for (let i = 0; i < rgba.length; i += 4) maximum = Math.max(maximum, rgba[i], rgba[i + 1], rgba[i + 2]);
  const length = SIZE * SIZE;
  const values = new Float32Array(length * 3);
  const mean = [0.485, 0.456, 0.406];
  const std = [0.229, 0.224, 0.225];
  for (let i = 0; i < length; i++) {
    for (let channel = 0; channel < 3; channel++) {
      values[channel * length + i] = (rgba[i * 4 + channel] / maximum - mean[channel]) / std[channel];
    }
  }
  return new ort.Tensor('float32', values, [1, 3, SIZE, SIZE]);
}

async function run(input: Blob): Promise<Blob> {
  progress({ phase: 'prepare' });
  const bitmap = await createImageBitmap(input, { imageOrientation: 'from-image' });
  let session: ort.InferenceSession | undefined;
  try {
    if (!bitmap.width || !bitmap.height || bitmap.width > 20_000 || bitmap.height > 20_000 || bitmap.width * bitmap.height > 16_000_000) {
      throw new Error('BACKGROUND_IMAGE_TOO_LARGE');
    }
    const model = await loadModel();
    progress({ phase: 'prepare' });
    // GitHub Pages provides no COOP/COEP: one WASM thread, inside our own worker.
    ort.env.wasm.numThreads = 1;
    ort.env.wasm.proxy = false;
    ort.env.wasm.wasmPaths = {
      wasm: new URL(wasmUrl, self.location.href).href,
      mjs: new URL(moduleUrl, self.location.href).href,
    };
    session = await ort.InferenceSession.create(model, { executionProviders: ['wasm'], graphOptimizationLevel: 'all' });
    const tensor = inputTensor(bitmap);
    progress({ phase: 'process' });
    const results = await session.run({ [session.inputNames[0]]: tensor }, [session.outputNames[0]]);
    tensor.dispose();
    const prediction = results[session.outputNames[0]];
    const data = prediction.data as Float32Array;
    const maskWidth = Number(prediction.dims[prediction.dims.length - 1]);
    const maskHeight = Number(prediction.dims[prediction.dims.length - 2]);
    if (data.length !== maskWidth * maskHeight) throw new Error('BACKGROUND_MODEL_OUTPUT_INVALID');
    let min = Infinity;
    let max = -Infinity;
    for (const value of data) { min = Math.min(min, value); max = Math.max(max, value); }
    if (!Number.isFinite(min) || !Number.isFinite(max)) throw new Error('BACKGROUND_MODEL_OUTPUT_INVALID');
    const range = max - min;
    const mask = canvas(maskWidth, maskHeight);
    const pixels = mask.context.createImageData(maskWidth, maskHeight);
    for (let i = 0; i < data.length; i++) {
      pixels.data[i * 4 + 3] = Math.round(Math.max(0, Math.min(1, range > 1e-6 ? (data[i] - min) / range : data[i])) * 255);
    }
    mask.context.putImageData(pixels, 0, 0);
    prediction.dispose();
    progress({ phase: 'finish' });

    const result = canvas(bitmap.width, bitmap.height);
    result.context.drawImage(bitmap, 0, 0);
    // destination-in multiplies the existing alpha by the soft model mask;
    // RGB and the original canvas size are retained, including partial transparency.
    result.context.globalCompositeOperation = 'destination-in';
    result.context.imageSmoothingQuality = 'high';
    result.context.drawImage(mask.surface, 0, 0, bitmap.width, bitmap.height);
    return await result.surface.convertToBlob({ type: 'image/png' });
  } finally {
    bitmap.close();
    await session?.release();
  }
}

scope.onmessage = ({ data }) => {
  run(data.input).then(
    (blob) => scope.postMessage({ type: 'result', blob }),
    (error: unknown) => scope.postMessage({ type: 'error', message: error instanceof Error ? error.message : 'BACKGROUND_PROCESS_FAILED' }),
  );
};
