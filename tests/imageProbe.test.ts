import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  assertSafeImageDimensions, probeImageDimensions,
} from '../src/imageProbe.ts';

function bytes(...parts: Uint8Array[]): Uint8Array {
  const result = new Uint8Array(parts.reduce((sum, part) => sum + part.length, 0));
  let offset = 0;
  for (const part of parts) {
    result.set(part, offset);
    offset += part.length;
  }
  return result;
}

function le16(value: number): Uint8Array {
  return Uint8Array.of(value & 255, (value >>> 8) & 255);
}

function le24(value: number): Uint8Array {
  return Uint8Array.of(value & 255, (value >>> 8) & 255, (value >>> 16) & 255);
}

function le32(value: number): Uint8Array {
  return bytes(le16(value), le16(value >>> 16));
}

function be16(value: number): Uint8Array {
  return Uint8Array.of((value >>> 8) & 255, value & 255);
}

function be32(value: number): Uint8Array {
  return bytes(be16(value >>> 16), be16(value));
}

function ascii(value: string): Uint8Array {
  return Uint8Array.from(value, (char) => char.charCodeAt(0));
}

function png(width: number, height: number): Uint8Array {
  const header = bytes(ascii('IHDR'), be32(width), be32(height),
    Uint8Array.of(8, 2, 0, 0, 0));
  let crc = 0xffff_ffff;
  for (const octet of header) {
    crc ^= octet;
    for (let bit = 0; bit < 8; bit += 1) {
      crc = (crc >>> 1) ^ (0xedb_88320 & -(crc & 1));
    }
  }
  return bytes(Uint8Array.of(0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a),
    be32(13), header, be32((crc ^ 0xffff_ffff) >>> 0));
}

function jpeg(width: number, height: number): Uint8Array {
  return bytes(Uint8Array.of(0xff, 0xd8),
    Uint8Array.of(0xff, 0xe1, 0, 4, 0x45, 0x78), // APP1 before the SOF marker.
    Uint8Array.of(0xff, 0xc2), be16(11), Uint8Array.of(8),
    be16(height), be16(width), Uint8Array.of(1, 1, 0x11, 0));
}

function chunk(name: string, payload: Uint8Array): Uint8Array {
  return bytes(ascii(name), le32(payload.length), payload,
    payload.length & 1 ? Uint8Array.of(0) : new Uint8Array());
}

function webp(...chunks: Uint8Array[]): Uint8Array {
  const content = bytes(ascii('WEBP'), ...chunks);
  return bytes(ascii('RIFF'), le32(content.length), content);
}

function vp8(width: number, height: number): Uint8Array {
  return chunk('VP8 ', bytes(Uint8Array.of(0, 0, 0, 0x9d, 0x01, 0x2a),
    le16(width), le16(height)));
}

function vp8l(width: number, height: number): Uint8Array {
  const w = width - 1;
  const h = height - 1;
  return chunk('VP8L', Uint8Array.of(0x2f, w & 255,
    ((w >>> 8) & 0x3f) | ((h & 3) << 6), (h >>> 2) & 255, (h >>> 10) & 15));
}

function vp8x(width: number, height: number, flags = 0): Uint8Array {
  return chunk('VP8X', bytes(Uint8Array.of(flags, 0, 0, 0),
    le24(width - 1), le24(height - 1)));
}

function bmp(width: number, height: number): Uint8Array {
  const header = new Uint8Array(54);
  const view = new DataView(header.buffer);
  header.set(ascii('BM'));
  view.setUint32(2, 54, true);
  view.setUint32(10, 54, true);
  view.setUint32(14, 40, true);
  view.setInt32(18, width, true);
  view.setInt32(22, height, true);
  view.setUint16(26, 1, true);
  view.setUint16(28, 24, true);
  return header;
}

test('PNG reads IHDR dimensions and rejects bad CRC, zero size, and truncation', () => {
  assert.deepEqual(probeImageDimensions(png(4000, 4000)),
    { format: 'png', width: 4000, height: 4000 });
  const damaged = png(20, 30);
  damaged[20] ^= 1;
  assert.throws(() => probeImageDimensions(damaged));
  assert.throws(() => probeImageDimensions(png(0, 30)));
  assert.throws(() => probeImageDimensions(png(20, 30).subarray(0, 32)));
});

test('JPEG scans marker segments to a valid SOF without decoding image data', () => {
  assert.deepEqual(probeImageDimensions(jpeg(20001, 10)),
    { format: 'jpeg', width: 20001, height: 10 });
  assert.throws(() => probeImageDimensions(jpeg(40, 50).subarray(0, 19)));
  const malformedLength = jpeg(40, 50);
  malformedLength[10] = 0xff;
  assert.throws(() => probeImageDimensions(malformedLength));
  assert.throws(() => probeImageDimensions(Uint8Array.of(0xff, 0xd8, 0xff, 0xd9)));
});

test('WebP reads simple lossy, simple lossless, and extended canvas dimensions', () => {
  assert.deepEqual(probeImageDimensions(webp(vp8(30, 40))),
    { format: 'webp', width: 30, height: 40 });
  assert.deepEqual(probeImageDimensions(webp(vp8l(1234, 5678))),
    { format: 'webp', width: 1234, height: 5678 });
  assert.deepEqual(probeImageDimensions(webp(vp8x(25, 35), vp8l(25, 35))),
    { format: 'webp', width: 25, height: 35 });
  assert.deepEqual(probeImageDimensions(webp(vp8x(25, 35),
    chunk('ANIM', new Uint8Array(6)), vp8l(25, 35))),
  { format: 'webp', width: 25, height: 35 });
});

test('WebP animated frames must fit and agree with the extended canvas', () => {
  const frameHeader = bytes(le24(2), le24(4), le24(9), le24(7), le24(100), Uint8Array.of(0));
  const good = webp(vp8x(20, 20, 0x02), chunk('ANIM', new Uint8Array(6)),
    chunk('ANMF', bytes(frameHeader, vp8(10, 8))));
  assert.deepEqual(probeImageDimensions(good), { format: 'webp', width: 20, height: 20 });
  assert.throws(() => probeImageDimensions(webp(vp8x(8, 8, 0x02),
    chunk('ANIM', new Uint8Array(6)), chunk('ANMF', bytes(frameHeader, vp8(10, 8))))));
  assert.throws(() => probeImageDimensions(webp(vp8x(20, 20, 0x02),
    chunk('ANIM', new Uint8Array(6)), chunk('ANMF', bytes(frameHeader, vp8(11, 8))))));
});

test('WebP rejects RIFF truncation, invalid bitstream signatures, and missing image chunks', () => {
  const lossless = webp(vp8l(2, 2));
  assert.throws(() => probeImageDimensions(lossless.subarray(0, lossless.length - 1)));
  const damaged = webp(vp8(2, 2));
  damaged[23] = 0;
  assert.throws(() => probeImageDimensions(damaged));
  const unknownLosslessVersion = webp(vp8l(2, 2));
  unknownLosslessVersion[24] |= 0xe0;
  assert.throws(() => probeImageDimensions(unknownLosslessVersion));
  assert.throws(() => probeImageDimensions(webp(vp8x(2, 2))));
  assert.throws(() => probeImageDimensions(webp(vp8x(2, 2), vp8(3, 2))));
});

test('BMP accepts common Windows and OS/2 headers and top-down rows', () => {
  assert.deepEqual(probeImageDimensions(bmp(25, -30)),
    { format: 'bmp', width: 25, height: 30 });
  const core = bytes(ascii('BM'), new Uint8Array(12), le32(12),
    le16(60), le16(70), le16(1), le16(24));
  assert.deepEqual(probeImageDimensions(core), { format: 'bmp', width: 60, height: 70 });
  assert.throws(() => probeImageDimensions(bmp(25, 30).subarray(0, 53)));
  assert.throws(() => probeImageDimensions(bmp(-25, 30)));
});

test('size guard enforces both pixel count and side length before decoding', () => {
  assert.deepEqual(assertSafeImageDimensions(probeImageDimensions(png(4000, 4000))),
    { format: 'png', width: 4000, height: 4000 });
  assert.throws(() => assertSafeImageDimensions(probeImageDimensions(png(4001, 4000))), RangeError);
  assert.throws(() => assertSafeImageDimensions(probeImageDimensions(jpeg(20001, 1))), RangeError);
  assert.throws(() => assertSafeImageDimensions(probeImageDimensions(bmp(20000, 801))), RangeError);
  assert.deepEqual(assertSafeImageDimensions(probeImageDimensions(bmp(10, 10)),
    { maxPixels: 100, maxSide: 10 }), { format: 'bmp', width: 10, height: 10 });
  assert.throws(() => assertSafeImageDimensions({ format: 'png', width: 1, height: 1 },
    { maxPixels: Infinity }), RangeError);
});

test('unknown files and incomplete signatures fail closed', () => {
  assert.throws(() => probeImageDimensions(new Uint8Array()));
  assert.throws(() => probeImageDimensions(ascii('RIFF')));
  assert.throws(() => probeImageDimensions(ascii('not an image')));
});
