import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  detectBackgroundColor, removeColorBackground,
  type ColorImageData, type RGB,
} from '../src/background/color.ts';

function fixture(rows: string[], colors: Record<string, readonly [number, number, number, number]>): ColorImageData {
  return { width: rows[0].length, height: rows.length,
    data: Uint8ClampedArray.from(rows.flatMap((row) => [...row].flatMap((key) => [...colors[key]]))) };
}

const white: RGB = [255, 255, 255];
const palette = { '.': [255, 255, 255, 255], '#': [20, 30, 40, 255] } as const;

function alphaAt(data: Uint8ClampedArray, image: ColorImageData, x: number, y: number): number {
  return data[(y * image.width + x) * 4 + 3];
}

test('automatic border removal preserves white inside a closed dark outline and never mutates input', () => {
  const image = fixture(['.......', '.#####.', '.#...#.', '.#####.', '.......'], palette);
  const original = image.data.slice();
  assert.deepEqual(detectBackgroundColor(image), white);
  const output = removeColorBackground(image);
  assert.equal(alphaAt(output, image, 0, 0), 0);
  assert.equal(alphaAt(output, image, 3, 4), 0);
  assert.equal(alphaAt(output, image, 3, 2), 255);
  assert.equal(alphaAt(output, image, 1, 2), 255);
  assert.deepEqual(image.data, original);
  assert.notEqual(output.buffer, image.data.buffer);
  for (let i = 0; i < output.length; i += 4) assert.deepEqual(output.slice(i, i + 3), image.data.slice(i, i + 3));
});

test('whole-image mode removes enclosed holes of the selected color', () => {
  const image = fixture(['.....', '.###.', '.#.#.', '.###.', '.....'], palette);
  const output = removeColorBackground(image, { contiguous: false });
  assert.equal(alphaAt(output, image, 2, 2), 0);
  assert.equal(alphaAt(output, image, 1, 2), 255);
});

test('explicit color overrides automatic detection', () => {
  const image = fixture(['g####', 'g.###', 'g####'], { ...palette, g: [0, 255, 0, 255] });
  assert.deepEqual(detectBackgroundColor(image), [20, 30, 40]);
  const output = removeColorBackground(image, { color: [0, 255, 0], tolerance: 0, softness: 0 });
  assert.equal(alphaAt(output, image, 0, 1), 0);
  assert.equal(alphaAt(output, image, 1, 1), 255);
  assert.equal(alphaAt(output, image, 4, 1), 255);
});

test('soft edges multiply existing alpha, preserve RGB, and keep already transparent pixels transparent', () => {
  const image = fixture(['.amt#'], {
    ...palette, a: [235, 235, 235, 200], m: [225, 225, 225, 120], t: [0, 50, 100, 0],
  });
  const output = removeColorBackground(image, { color: white, tolerance: 10, softness: 40 });
  assert.equal(alphaAt(output, image, 0, 0), 0);
  assert.equal(alphaAt(output, image, 1, 0), 31);
  assert.equal(alphaAt(output, image, 2, 0), 60);
  assert.equal(alphaAt(output, image, 3, 0), 0);
  assert.equal(alphaAt(output, image, 4, 0), 255);
  for (let i = 0; i < output.length; i += 4) {
    assert.deepEqual(output.slice(i, i + 3), image.data.slice(i, i + 3));
    assert.ok(output[i + 3] <= image.data[i + 3]);
  }
});

test('an already transparent boundary causes auto mode to preserve the existing cutout', () => {
  const image = fixture(['ttttt', 't...t', 't.#.t', 't...t', 'ttttt'], {
    ...palette, t: [90, 80, 70, 0],
  });
  assert.equal(detectBackgroundColor(image), null);
  assert.deepEqual(removeColorBackground(image), image.data);
  const explicit = removeColorBackground(image, { color: white, tolerance: 0, softness: 0 });
  assert.equal(alphaAt(explicit, image, 1, 1), 0);
  assert.equal(alphaAt(explicit, image, 2, 2), 255);
});

test('dominant border detection resists a subject touching the corner and small color noise', () => {
  const image = fixture(['#nnn...', '.......', '.......', '.......'], {
    ...palette, n: [249, 251, 253, 255],
  });
  const color = detectBackgroundColor(image)!;
  assert.ok(color.every((channel) => channel >= 253));
  const output = removeColorBackground(image);
  assert.equal(alphaAt(output, image, 0, 0), 255);
  assert.equal(alphaAt(output, image, 1, 0), 0);
});

test('tolerance controls color inclusion, including exact-match mode', () => {
  const image = fixture(['.n#'], { ...palette, n: [250, 250, 250, 255] });
  const exact = removeColorBackground(image, { color: white, tolerance: 0, softness: 0 });
  assert.equal(alphaAt(exact, image, 0, 0), 0);
  assert.equal(alphaAt(exact, image, 1, 0), 255);
  const wider = removeColorBackground(image, { color: white, tolerance: 5, softness: 0 });
  assert.equal(alphaAt(wider, image, 1, 0), 0);
  assert.equal(alphaAt(wider, image, 2, 0), 255);
});

test('all-background images and single-pixel dimensions remove completely', () => {
  for (const rows of [['....', '....', '....'], ['.'], ['.', '.', '.'], ['....']]) {
    const image = fixture(rows, palette);
    const output = removeColorBackground(image);
    for (let i = 3; i < output.length; i += 4) assert.equal(output[i], 0);
  }
});

test('connected removal follows winding paths without leaking diagonally through foreground', () => {
  const image = fixture(['.####', '...##', '##.##', '##..#', '####.'], palette);
  const output = removeColorBackground(image, { color: white, softness: 0 });
  assert.equal(alphaAt(output, image, 3, 3), 0);
  // An enclosed pixel touches outside only diagonally, which is not an open path.
  const enclosed = fixture(['.####', '#.###', '#####', '#####', '#####'], palette);
  assert.equal(alphaAt(removeColorBackground(enclosed, { color: white }), enclosed, 1, 1), 255);
});

test('scanline connectivity agrees with a simple four-neighbor flood on varied small masks', () => {
  let seed = 812;
  const random = (): number => {
    seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
    return seed / 0x1_0000_0000;
  };
  for (let trial = 0; trial < 120; trial += 1) {
    const width = 1 + Math.floor(random() * 18);
    const height = 1 + Math.floor(random() * 18);
    const rows = Array.from({ length: height }, () =>
      Array.from({ length: width }, () => random() < 0.6 ? '.' : '#').join(''));
    const image = fixture(rows, palette);
    const removed = new Set<number>();
    const pending: number[] = [];
    const visit = (x: number, y: number): void => {
      if (x < 0 || x >= width || y < 0 || y >= height || rows[y][x] !== '.') return;
      const pixel = y * width + x;
      if (removed.has(pixel)) return;
      removed.add(pixel);
      pending.push(pixel);
    };
    for (let x = 0; x < width; x += 1) { visit(x, 0); visit(x, height - 1); }
    for (let y = 0; y < height; y += 1) { visit(0, y); visit(width - 1, y); }
    for (let cursor = 0; cursor < pending.length; cursor += 1) {
      const x = pending[cursor] % width;
      const y = Math.floor(pending[cursor] / width);
      visit(x - 1, y); visit(x + 1, y); visit(x, y - 1); visit(x, y + 1);
    }
    const output = removeColorBackground(image, { color: white, tolerance: 0, softness: 0 });
    for (let pixel = 0; pixel < width * height; pixel += 1) {
      assert.equal(output[pixel * 4 + 3], removed.has(pixel) ? 0 : 255, `trial ${trial}, pixel ${pixel}`);
    }
  }
});

test('invalid dimensions and controls fail before image-sized allocations', () => {
  const image = fixture(['.'], palette);
  assert.throws(() => removeColorBackground({ ...image, width: 16_000_001 }), RangeError);
  assert.throws(() => removeColorBackground({ ...image, width: 0 }), RangeError);
  assert.throws(() => removeColorBackground({ ...image, data: new Uint8Array(3) }), RangeError);
  assert.throws(() => removeColorBackground(image, { tolerance: Number.NaN }), RangeError);
  assert.throws(() => removeColorBackground(image, { softness: -1 }), RangeError);
  assert.throws(() => removeColorBackground(image, { color: [0, 0, 256] }), RangeError);
});
