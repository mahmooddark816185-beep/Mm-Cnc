import { removeColorBackground } from './color';
import type { SolidBackgroundOptions } from './colorClient';

const scope = self as unknown as {
  onmessage: ((event: MessageEvent<{ input: Blob; options: Omit<SolidBackgroundOptions, 'signal'> }>) => void) | null;
  postMessage: (message: { blob?: Blob; error?: string }) => void;
};

scope.onmessage = async ({ data: { input, options } }) => {
  let bitmap: ImageBitmap | undefined;
  try {
    bitmap = await createImageBitmap(input);
    if (bitmap.width * bitmap.height > 16_000_000 || Math.max(bitmap.width, bitmap.height) > 20_000) {
      throw new Error('Image dimensions exceed the limit.');
    }
    const canvas = new OffscreenCanvas(bitmap.width, bitmap.height);
    const context = canvas.getContext('2d', { willReadFrequently: true });
    if (!context) throw new Error('Canvas unavailable');
    context.drawImage(bitmap, 0, 0);
    const pixels = context.getImageData(0, 0, bitmap.width, bitmap.height);
    const rgba = removeColorBackground(pixels, options);
    pixels.data.set(rgba);
    context.putImageData(pixels, 0, 0);
    scope.postMessage({ blob: await canvas.convertToBlob({ type: 'image/png' }) });
  } catch (error) {
    scope.postMessage({ error: error instanceof Error ? error.message : 'Background processing failed.' });
  } finally {
    bitmap?.close();
  }
};
