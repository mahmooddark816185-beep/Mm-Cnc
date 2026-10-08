import assert from 'node:assert/strict';
import test from 'node:test';
import {
  exportBinaryMaskToStl,
  STL_MAX_FILLED_CELLS,
  STL_MAX_MASK_PIXELS,
} from '../src/engine/stl.ts';

type Vec3 = [number, number, number];
type Triangle = { normal: Vec3; vertices: [Vec3, Vec3, Vec3] };

function readStl(bytes: Uint8Array): Triangle[] {
  const data = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const triangleCount = data.getUint32(80, true);
  assert.equal(bytes.byteLength, 84 + triangleCount * 50);
  const triangles: Triangle[] = [];
  for (let t = 0; t < triangleCount; t += 1) {
    const offset = 84 + t * 50;
    const vector = (start: number): Vec3 => [
      data.getFloat32(start, true),
      data.getFloat32(start + 4, true),
      data.getFloat32(start + 8, true),
    ];
    triangles.push({
      normal: vector(offset),
      vertices: [vector(offset + 12), vector(offset + 24), vector(offset + 36)],
    });
  }
  return triangles;
}

function edgeOccurrences(triangles: Triangle[]): Map<string, number> {
  const edges = new Map<string, number>();
  const point = (vertex: Vec3): string => vertex.join(',');
  for (const triangle of triangles) {
    for (let i = 0; i < 3; i += 1) {
      const ends = [
        point(triangle.vertices[i]),
        point(triangle.vertices[(i + 1) % 3]),
      ].sort();
      const key = ends.join('|');
      edges.set(key, (edges.get(key) ?? 0) + 1);
    }
  }
  return edges;
}

function assertClosedManifold(triangles: Triangle[]): void {
  const edges = edgeOccurrences(triangles);
  assert.ok(edges.size > 0);
  for (const [edge, count] of edges) {
    assert.equal(count, 2, `Open or non-manifold edge: ${edge}`);
  }
}

function signedVolume(triangles: Triangle[]): number {
  let sum = 0;
  for (const { vertices: [a, b, c] } of triangles) {
    const crossX = b[1] * c[2] - b[2] * c[1];
    const crossY = b[2] * c[0] - b[0] * c[2];
    const crossZ = b[0] * c[1] - b[1] * c[0];
    sum += (a[0] * crossX + a[1] * crossY + a[2] * crossZ) / 6;
  }
  return sum;
}

test('one image pixel becomes a 1 mm closed solid with 12 triangles', () => {
  const bytes = exportBinaryMaskToStl(new Uint8Array([1]), 1, 1);
  const triangles = readStl(bytes);
  assert.equal(triangles.length, 12);
  assertClosedManifold(triangles);
  assert.ok(Math.abs(signedVolume(triangles) - 1) < 1e-6);
  const xyz = triangles.flatMap((face) => face.vertices);
  assert.deepEqual([Math.min(...xyz.map((v) => v[0])), Math.max(...xyz.map((v) => v[0]))], [0, 1]);
  assert.deepEqual([Math.min(...xyz.map((v) => v[1])), Math.max(...xyz.map((v) => v[1]))], [0, 1]);
  assert.deepEqual([Math.min(...xyz.map((v) => v[2])), Math.max(...xyz.map((v) => v[2]))], [0, 1]);
});

test('top-left mask pixel uses millimetres and Y-up coordinates', () => {
  const triangles = readStl(exportBinaryMaskToStl(new Uint8Array([1, 0, 0, 0]), 2, 2, {
    pixelSizeMm: 2,
    thicknessMm: 3,
  }));
  assertClosedManifold(triangles);
  assert.ok(Math.abs(signedVolume(triangles) - 12) < 1e-5);
  const xyz = triangles.flatMap((face) => face.vertices);
  assert.deepEqual([Math.min(...xyz.map((v) => v[0])), Math.max(...xyz.map((v) => v[0]))], [0, 2]);
  assert.deepEqual([Math.min(...xyz.map((v) => v[1])), Math.max(...xyz.map((v) => v[1]))], [2, 4]);
  assert.deepEqual([Math.min(...xyz.map((v) => v[2])), Math.max(...xyz.map((v) => v[2]))], [0, 3]);
});

test('adjoining pixels form one closed shell without internal walls', () => {
  const triangles = readStl(exportBinaryMaskToStl(new Uint8Array([1, 1]), 2, 1));
  assert.equal(triangles.length, 20); // 8 cap faces + 12 exterior wall faces
  assertClosedManifold(triangles);
  assert.ok(Math.abs(signedVolume(triangles) - 2) < 1e-6);
  assert.ok(!triangles.some((t) => t.vertices.every((v) => v[0] === 1) && t.normal[0] !== 0));
});

test('an enclosed transparent pixel remains a real, walled through-hole', () => {
  const mask = new Uint8Array([
    1, 1, 1,
    1, 0, 1,
    1, 1, 1,
  ]);
  const triangles = readStl(exportBinaryMaskToStl(mask, 3, 3, { thicknessMm: 2 }));
  assert.equal(triangles.length, 64);
  assertClosedManifold(triangles);
  assert.ok(Math.abs(signedVolume(triangles) - 16) < 1e-5);
  const innerLeftWall = triangles.find((t) =>
    t.vertices.every((v) => v[0] === 1 && v[1] >= 1 && v[1] <= 2) && t.normal[0] > 0.9);
  assert.ok(innerLeftWall, 'hole boundary should have an inward-facing wall');
});

test('diagonal-only contact is bevelled into closed, non-touching shells', () => {
  const triangles = readStl(exportBinaryMaskToStl(new Uint8Array([
    1, 0,
    0, 1,
  ]), 2, 2));
  assertClosedManifold(triangles);
  assert.ok(!triangles.flatMap((t) => t.vertices).some((v) => v[0] === 1 && v[1] === 1));
  assert.ok(signedVolume(triangles) > 1.9 && signedVolume(triangles) < 2);
});

test('every nonempty 3x3 binary pattern produces a closed mesh', () => {
  for (let bits = 1; bits < 512; bits += 1) {
    const mask = Uint8Array.from({ length: 9 }, (_, i) => (bits >> i) & 1);
    const triangles = readStl(exportBinaryMaskToStl(mask, 3, 3));
    try {
      assertClosedManifold(triangles);
      assert.ok(signedVolume(triangles) > 0);
    } catch (error) {
      throw new Error(`Invalid 3x3 pattern ${bits.toString(2).padStart(9, '0')}`, { cause: error });
    }
  }
});

test('rejects unusable masks and enforces browser memory limits', () => {
  assert.throws(() => exportBinaryMaskToStl(new Uint8Array([0]), 1, 1), /no solid pixels/);
  assert.throws(() => exportBinaryMaskToStl(new Uint8Array([1]), 2, 1), /length/);
  assert.throws(() => exportBinaryMaskToStl(new Uint8Array([255]), 1, 1), /non-binary/);
  assert.throws(() => exportBinaryMaskToStl(new Uint8Array([1]), 1, 1, { thicknessMm: 0 }), /positive/);
  assert.throws(() => exportBinaryMaskToStl(new Uint8Array([1]), 1, 1, { pixelSizeMm: Number.NaN }), /positive/);
  assert.throws(() => exportBinaryMaskToStl(new Uint8Array(0), STL_MAX_MASK_PIXELS + 1, 1), /exceeds/);
  assert.throws(() => exportBinaryMaskToStl(new Uint8Array(STL_MAX_FILLED_CELLS + 1).fill(1), STL_MAX_FILLED_CELLS + 1, 1), /filled pixels/);
});
