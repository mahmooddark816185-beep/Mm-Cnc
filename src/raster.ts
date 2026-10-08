/** Encode at the source pixel dimensions, independently of the tracing preview. */
export async function exportRasterPng(source: Blob): Promise<Blob> {
  // File MIME types can come from the filename. Preserve exact PNG bytes only
  // when the content has a PNG signature, including files with a wrong MIME type.
  const header = new Uint8Array(await source.slice(0, 8).arrayBuffer());
  const pngSignature = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
  if (header.length === pngSignature.length && pngSignature.every((byte, index) => header[index] === byte)) {
    return source;
  }
  const bitmap = await createImageBitmap(source);
  try {
    if (typeof OffscreenCanvas !== 'undefined') {
      const canvas = new OffscreenCanvas(bitmap.width, bitmap.height);
      const context = canvas.getContext('2d');
      if (!context) throw new Error('Canvas unavailable');
      context.drawImage(bitmap, 0, 0);
      return await canvas.convertToBlob({ type: 'image/png' });
    }
    const canvas = document.createElement('canvas');
    canvas.width = bitmap.width;
    canvas.height = bitmap.height;
    const context = canvas.getContext('2d');
    if (!context) throw new Error('Canvas unavailable');
    context.drawImage(bitmap, 0, 0);
    return await new Promise<Blob>((resolve, reject) => canvas.toBlob(
      (blob) => blob ? resolve(blob) : reject(new Error('PNG encoding failed')), 'image/png'));
  } finally {
    bitmap.close();
  }
}
