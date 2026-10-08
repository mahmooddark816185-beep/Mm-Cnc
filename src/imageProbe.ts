/** Image dimensions read from file headers, without invoking an image decoder. */
export interface ImageDimensions {
  format: 'png' | 'jpeg' | 'webp' | 'bmp';
  width: number;
  height: number;
}

export interface ImageDimensionLimits {
  maxPixels?: number;
  maxSide?: number;
}

export const DEFAULT_IMAGE_LIMITS = {
  maxPixels: 16_000_000,
  maxSide: 20_000,
} as const;

function malformed(): never {
  throw new Error('Unsupported or malformed image.');
}

function has(bytes: Uint8Array, offset: number, length: number): boolean {
  return offset >= 0 && length >= 0 && offset <= bytes.length - length;
}

function u16be(bytes: Uint8Array, offset: number): number {
  return (bytes[offset] << 8) | bytes[offset + 1];
}

function u16le(bytes: Uint8Array, offset: number): number {
  return bytes[offset] | (bytes[offset + 1] << 8);
}

function u24le(bytes: Uint8Array, offset: number): number {
  return bytes[offset] | (bytes[offset + 1] << 8) | (bytes[offset + 2] << 16);
}

function u32be(bytes: Uint8Array, offset: number): number {
  return ((bytes[offset] << 24) | (bytes[offset + 1] << 16) |
    (bytes[offset + 2] << 8) | bytes[offset + 3]) >>> 0;
}

function u32le(bytes: Uint8Array, offset: number): number {
  return (bytes[offset] | (bytes[offset + 1] << 8) |
    (bytes[offset + 2] << 16) | (bytes[offset + 3] << 24)) >>> 0;
}

function i32le(bytes: Uint8Array, offset: number): number {
  return bytes[offset] | (bytes[offset + 1] << 8) |
    (bytes[offset + 2] << 16) | (bytes[offset + 3] << 24);
}

function tag(bytes: Uint8Array, offset: number): string {
  return String.fromCharCode(bytes[offset], bytes[offset + 1], bytes[offset + 2], bytes[offset + 3]);
}

function validSize(width: number, height: number): void {
  if (!Number.isSafeInteger(width) || !Number.isSafeInteger(height) || width <= 0 || height <= 0) {
    malformed();
  }
}

function crc32(bytes: Uint8Array, start: number, end: number): number {
  let crc = 0xffff_ffff;
  for (let i = start; i < end; i += 1) {
    crc ^= bytes[i];
    for (let bit = 0; bit < 8; bit += 1) {
      crc = (crc >>> 1) ^ (0xedb_88320 & -(crc & 1));
    }
  }
  return (crc ^ 0xffff_ffff) >>> 0;
}

function probePng(bytes: Uint8Array): ImageDimensions {
  // The first PNG chunk must be a complete 13-byte IHDR with a valid CRC.
  if (!has(bytes, 0, 33) || u32be(bytes, 8) !== 13 || tag(bytes, 12) !== 'IHDR' ||
    crc32(bytes, 12, 29) !== u32be(bytes, 29)) {
    malformed();
  }
  const width = u32be(bytes, 16);
  const height = u32be(bytes, 20);
  validSize(width, height);
  if (width > 0x7fff_ffff || height > 0x7fff_ffff ||
    bytes[26] !== 0 || bytes[27] !== 0 || bytes[28] > 1) {
    malformed();
  }
  return { format: 'png', width, height };
}

function isSof(marker: number): boolean {
  return (marker >= 0xc0 && marker <= 0xc3) ||
    (marker >= 0xc5 && marker <= 0xc7) ||
    (marker >= 0xc9 && marker <= 0xcb) ||
    (marker >= 0xcd && marker <= 0xcf);
}

function probeJpeg(bytes: Uint8Array): ImageDimensions {
  let offset = 2;
  while (offset < bytes.length) {
    if (bytes[offset++] !== 0xff) malformed();
    while (offset < bytes.length && bytes[offset] === 0xff) offset += 1;
    if (!has(bytes, offset, 1)) malformed();
    const marker = bytes[offset++];
    if (marker === 0x00 || marker === 0xd8 || marker === 0xd9 || marker === 0xda) malformed();
    if (marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) continue;
    if (!has(bytes, offset, 2)) malformed();
    const length = u16be(bytes, offset);
    if (length < 2 || !has(bytes, offset, length)) malformed();
    if (isSof(marker)) {
      if (length < 11 || bytes[offset + 2] === 0 ||
        length !== 8 + 3 * bytes[offset + 7]) malformed();
      const height = u16be(bytes, offset + 3);
      const width = u16be(bytes, offset + 5);
      validSize(width, height);
      return { format: 'jpeg', width, height };
    }
    offset += length;
  }
  return malformed();
}

interface Chunk {
  name: string;
  start: number;
  end: number;
  next: number;
}

function chunkAt(bytes: Uint8Array, offset: number, boundary: number): Chunk {
  if (offset > boundary - 8) malformed();
  const length = u32le(bytes, offset + 4);
  const start = offset + 8;
  if (length > boundary - start) malformed();
  const end = start + length;
  const next = end + (length & 1);
  if (next > boundary) malformed();
  return { name: tag(bytes, offset), start, end, next };
}

function vp8Size(bytes: Uint8Array, chunk: Chunk): { width: number; height: number } {
  const p = chunk.start;
  if (chunk.end - p < 10 || (bytes[p] & 1) !== 0 ||
    bytes[p + 3] !== 0x9d || bytes[p + 4] !== 0x01 || bytes[p + 5] !== 0x2a) malformed();
  const width = u16le(bytes, p + 6) & 0x3fff;
  const height = u16le(bytes, p + 8) & 0x3fff;
  validSize(width, height);
  return { width, height };
}

function vp8lSize(bytes: Uint8Array, chunk: Chunk): { width: number; height: number } {
  const p = chunk.start;
  if (chunk.end - p < 5 || bytes[p] !== 0x2f || (bytes[p + 4] & 0xe0) !== 0) malformed();
  const width = 1 + bytes[p + 1] + ((bytes[p + 2] & 0x3f) << 8);
  const height = 1 + ((bytes[p + 2] >> 6) | (bytes[p + 3] << 2) | ((bytes[p + 4] & 0x0f) << 10));
  return { width, height };
}

function webpBitstreamSize(bytes: Uint8Array, chunk: Chunk): { width: number; height: number } {
  return chunk.name === 'VP8 ' ? vp8Size(bytes, chunk) : vp8lSize(bytes, chunk);
}

function animatedFrameSize(bytes: Uint8Array, chunk: Chunk, canvas: { width: number; height: number }): void {
  const p = chunk.start;
  if (chunk.end - p < 24) malformed();
  const x = 2 * u24le(bytes, p);
  const y = 2 * u24le(bytes, p + 3);
  const width = 1 + u24le(bytes, p + 6);
  const height = 1 + u24le(bytes, p + 9);
  if (x + width > canvas.width || y + height > canvas.height) malformed();
  let foundImage = false;
  for (let offset = p + 16; offset < chunk.end;) {
    const inner = chunkAt(bytes, offset, chunk.end);
    if (inner.name === 'VP8 ' || inner.name === 'VP8L') {
      if (foundImage) malformed();
      const actual = webpBitstreamSize(bytes, inner);
      if (actual.width !== width || actual.height !== height) malformed();
      foundImage = true;
    }
    offset = inner.next;
  }
  if (!foundImage) malformed();
}

function probeWebp(bytes: Uint8Array): ImageDimensions {
  if (!has(bytes, 0, 20)) malformed();
  const total = u32le(bytes, 4) + 8;
  if (total > bytes.length || total < 20) malformed();
  const first = chunkAt(bytes, 12, total);
  if (first.name === 'VP8 ' || first.name === 'VP8L') {
    const size = webpBitstreamSize(bytes, first);
    for (let offset = first.next; offset < total;) offset = chunkAt(bytes, offset, total).next;
    return { format: 'webp', ...size };
  }
  if (first.name !== 'VP8X' || first.end - first.start !== 10) malformed();
  const p = first.start;
  const canvas = {
    width: 1 + u24le(bytes, p + 4),
    height: 1 + u24le(bytes, p + 7),
  };
  const animated = (bytes[p] & 0x02) !== 0;
  let hasAnim = false;
  let imageCount = 0;
  for (let offset = first.next; offset < total;) {
    const chunk = chunkAt(bytes, offset, total);
    if (chunk.name === 'ANIM') {
      if (animated) {
        if (hasAnim || chunk.end - chunk.start < 6) malformed();
        hasAnim = true;
      }
    } else if (chunk.name === 'ANMF') {
      if (animated) {
        if (!hasAnim) malformed();
        animatedFrameSize(bytes, chunk, canvas);
        imageCount += 1;
      }
    } else if (chunk.name === 'VP8 ' || chunk.name === 'VP8L') {
      if (animated || imageCount) malformed();
      const actual = webpBitstreamSize(bytes, chunk);
      if (actual.width !== canvas.width || actual.height !== canvas.height) malformed();
      imageCount += 1;
    }
    offset = chunk.next;
  }
  if (imageCount === 0) malformed();
  return { format: 'webp', ...canvas };
}

function probeBmp(bytes: Uint8Array): ImageDimensions {
  if (!has(bytes, 0, 26)) malformed();
  const dibSize = u32le(bytes, 14);
  if (dibSize < 12 || dibSize > bytes.length - 14) malformed();
  let width: number;
  let height: number;
  if (dibSize === 12) {
    width = u16le(bytes, 18);
    height = u16le(bytes, 20);
  } else {
    if (dibSize < 16 || !has(bytes, 0, 26)) malformed();
    width = i32le(bytes, 18);
    height = Math.abs(i32le(bytes, 22)); // Negative means top-down rows.
  }
  validSize(width, height);
  return { format: 'bmp', width, height };
}

/** Probe PNG, JPEG, WebP and BMP headers. Full compressed-pixel validation remains the decoder's job. */
export function probeImageDimensions(bytes: Uint8Array): ImageDimensions {
  if (has(bytes, 0, 8) &&
    bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47 &&
    bytes[4] === 0x0d && bytes[5] === 0x0a && bytes[6] === 0x1a && bytes[7] === 0x0a) {
    return probePng(bytes);
  }
  if (has(bytes, 0, 2) && bytes[0] === 0xff && bytes[1] === 0xd8) return probeJpeg(bytes);
  if (has(bytes, 0, 12) && tag(bytes, 0) === 'RIFF' && tag(bytes, 8) === 'WEBP') {
    return probeWebp(bytes);
  }
  if (has(bytes, 0, 2) && bytes[0] === 0x42 && bytes[1] === 0x4d) return probeBmp(bytes);
  return malformed();
}

/** Call before creating an Image/object URL or decoding the file. */
export function assertSafeImageDimensions(
  dimensions: ImageDimensions,
  limits: ImageDimensionLimits = DEFAULT_IMAGE_LIMITS,
): ImageDimensions {
  const maxPixels = limits.maxPixels ?? DEFAULT_IMAGE_LIMITS.maxPixels;
  const maxSide = limits.maxSide ?? DEFAULT_IMAGE_LIMITS.maxSide;
  if (!Number.isSafeInteger(maxPixels) || maxPixels <= 0 ||
    !Number.isSafeInteger(maxSide) || maxSide <= 0) {
    throw new RangeError('Image dimension limits must be positive safe integers.');
  }
  const { width, height } = dimensions;
  if (!Number.isSafeInteger(width) || !Number.isSafeInteger(height) ||
    width <= 0 || height <= 0 || width > maxSide || height > maxSide ||
    width > maxPixels / height) {
    throw new RangeError('Image dimensions exceed the safe limit.');
  }
  return dimensions;
}
