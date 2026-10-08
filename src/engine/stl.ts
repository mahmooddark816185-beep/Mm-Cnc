/**
 * Extrudes a binary raster into a closed, binary STL mesh.
 *
 * Coordinates are millimetres: the top-left mask pixel starts at x=0 and
 * y=(height - 1) * pixelSizeMm, and the bottom-left of the image is (0, 0).
 * The model occupies z=0..thicknessMm. STL has no standard unit field, so the
 * importing CAD program must be set to millimetres.
 *
 * Each filled pixel is a square. Top and bottom caps are tiled; only exposed
 * edges receive walls. A pair of squares meeting only at a diagonal corner is
 * bevelled apart by 10% of a pixel so STL importers do not weld a non-manifold
 * point. Holes and disconnected islands remain open/independent in XY while
 * every individual 3D shell is closed.
 */

export const STL_MAX_MASK_PIXELS = 4_000_000;
export const STL_MAX_FILLED_CELLS = 200_000;
export const STL_MAX_TRIANGLES = 1_000_000; // At most 50,000,084 output bytes.

export interface StlOptions {
  pixelSizeMm?: number;
  thicknessMm?: number;
  /** Optional stricter limit for a particular browser/device. */
  maxCells?: number;
}

type BinaryMask = Uint8Array | readonly number[] | readonly boolean[];
type Point = readonly [number, number];
type Vertex = readonly [number, number, number];

function validPositiveNumber(value: number, label: string): void {
  if (!Number.isFinite(value) || value <= 0) {
    throw new RangeError(`${label} must be a positive, finite number`);
  }
}

/** Returns a complete binary STL file, including its 84-byte header. */
export function exportBinaryMaskToStl(
  mask: BinaryMask,
  width: number,
  height: number,
  options: StlOptions = {},
): Uint8Array {
  if (!Number.isSafeInteger(width) || !Number.isSafeInteger(height) || width < 1 || height < 1) {
    throw new RangeError('STL mask width and height must be positive integers');
  }
  const pixelCount = width * height;
  if (!Number.isSafeInteger(pixelCount) || pixelCount > STL_MAX_MASK_PIXELS) {
    throw new RangeError(`STL mask exceeds ${STL_MAX_MASK_PIXELS} pixels`);
  }
  if (mask.length !== pixelCount) {
    throw new RangeError('STL mask length must equal width * height');
  }

  const pixelSizeMm = options.pixelSizeMm ?? 1;
  const thicknessMm = options.thicknessMm ?? 1;
  validPositiveNumber(pixelSizeMm, 'pixelSizeMm');
  validPositiveNumber(thicknessMm, 'thicknessMm');
  const maxCells = options.maxCells ?? STL_MAX_FILLED_CELLS;
  if (!Number.isSafeInteger(maxCells) || maxCells < 1 || maxCells > STL_MAX_FILLED_CELLS) {
    throw new RangeError(`maxCells must be an integer from 1 to ${STL_MAX_FILLED_CELLS}`);
  }

  // Float32 is required by STL. Detect dimensions that would collapse adjacent
  // grid lines or the model thickness when converted to that precision.
  if (
    !Number.isFinite(Math.fround(width * pixelSizeMm)) ||
    !Number.isFinite(Math.fround(height * pixelSizeMm)) ||
    !Number.isFinite(Math.fround(thicknessMm)) ||
    Math.fround(thicknessMm) <= 0 ||
    Math.fround((width - 1) * pixelSizeMm) === Math.fround(width * pixelSizeMm) ||
    Math.fround((height - 1) * pixelSizeMm) === Math.fround(height * pixelSizeMm)
  ) {
    throw new RangeError('STL dimensions exceed float32 coordinate precision; adjust the scale or image size');
  }

  // Validate the entire input once; only exact 0/1 (or boolean) values are
  // allowed, avoiding accidental conversion of unthresholded grayscale data.
  let filledCells = 0;
  for (let i = 0; i < pixelCount; i += 1) {
    const value = mask[i];
    if (value !== 0 && value !== 1 && value !== false && value !== true) {
      throw new TypeError(`STL mask contains a non-binary value at index ${i}`);
    }
    if (value === 1 || value === true) {
      filledCells += 1;
      if (filledCells > maxCells) {
        throw new RangeError(`STL exceeds the limit of ${maxCells} filled pixels`);
      }
    }
  }
  if (filledCells === 0) {
    throw new RangeError('STL mask contains no solid pixels');
  }

  const solid = (row: number, col: number): boolean =>
    row >= 0 && row < height && col >= 0 && col < width &&
    (mask[row * width + col] === 1 || mask[row * width + col] === true);

  // Corner order BL, BR, TR, TL is counter-clockwise in the exported XY plane.
  // For each corner: diagonal neighbour; two side-adjacent neighbours.
  const clippedCorners = (row: number, col: number): [boolean, boolean, boolean, boolean] => [
    solid(row + 1, col - 1) && !solid(row + 1, col) && !solid(row, col - 1),
    solid(row + 1, col + 1) && !solid(row + 1, col) && !solid(row, col + 1),
    solid(row - 1, col + 1) && !solid(row - 1, col) && !solid(row, col + 1),
    solid(row - 1, col - 1) && !solid(row - 1, col) && !solid(row, col - 1),
  ];

  const exposedSides = (row: number, col: number): [boolean, boolean, boolean, boolean] => [
    !solid(row + 1, col), // BL -> BR: bottom
    !solid(row, col + 1), // BR -> TR: right
    !solid(row - 1, col), // TR -> TL: top
    !solid(row, col - 1), // TL -> BL: left
  ];

  // A first pass computes the exact output size. No growing triangle array is
  // kept in memory: the second pass writes directly into the final buffer.
  let triangleCount = 0;
  for (let row = 0; row < height; row += 1) {
    for (let col = 0; col < width; col += 1) {
      if (!solid(row, col)) continue;
      const cornerCount = clippedCorners(row, col).filter(Boolean).length;
      const exposedCount = exposedSides(row, col).filter(Boolean).length;
      triangleCount += 4 + 4 * cornerCount + 2 * exposedCount;
      if (triangleCount > STL_MAX_TRIANGLES) {
        throw new RangeError(`STL exceeds ${STL_MAX_TRIANGLES} triangles (50 MB)`);
      }
    }
  }

  const buffer = new ArrayBuffer(84 + triangleCount * 50);
  const data = new DataView(buffer);
  const header = new TextEncoder().encode('Mm Cnc binary STL | coordinates in mm | closed raster extrusion');
  new Uint8Array(buffer, 0, header.length).set(header);
  data.setUint32(80, triangleCount, true);
  let offset = 84;

  const triangle = (a: Vertex, b: Vertex, c: Vertex): void => {
    const ux = b[0] - a[0], uy = b[1] - a[1], uz = b[2] - a[2];
    const vx = c[0] - a[0], vy = c[1] - a[1], vz = c[2] - a[2];
    const nx = uy * vz - uz * vy;
    const ny = uz * vx - ux * vz;
    const nz = ux * vy - uy * vx;
    const length = Math.hypot(nx, ny, nz);
    if (!(length > 0)) {
      throw new RangeError('STL precision collapsed a triangle; adjust pixelSizeMm or image size');
    }
    data.setFloat32(offset, nx / length, true);
    data.setFloat32(offset + 4, ny / length, true);
    data.setFloat32(offset + 8, nz / length, true);
    const vertices = [a, b, c];
    for (let i = 0; i < 3; i += 1) {
      data.setFloat32(offset + 12 + i * 12, vertices[i][0], true);
      data.setFloat32(offset + 16 + i * 12, vertices[i][1], true);
      data.setFloat32(offset + 20 + i * 12, vertices[i][2], true);
    }
    data.setUint16(offset + 48, 0, true);
    offset += 50;
  };

  const wall = (from: Point, to: Point): void => {
    const a0: Vertex = [from[0], from[1], 0];
    const b0: Vertex = [to[0], to[1], 0];
    const a1: Vertex = [from[0], from[1], thicknessMm];
    const b1: Vertex = [to[0], to[1], thicknessMm];
    triangle(a0, b0, b1);
    triangle(a0, b1, a1);
  };

  for (let row = 0; row < height; row += 1) {
    for (let col = 0; col < width; col += 1) {
      if (!solid(row, col)) continue;
      const x0 = col * pixelSizeMm;
      const x1 = (col + 1) * pixelSizeMm;
      const y0 = (height - row - 1) * pixelSizeMm;
      const y1 = (height - row) * pixelSizeMm;
      const corners: Point[] = [[x0, y0], [x1, y0], [x1, y1], [x0, y1]];
      const clips = clippedCorners(row, col);
      const exposed = exposedSides(row, col);
      const incoming: Point[] = [];
      const outgoing: Point[] = [];
      const polygon: Point[] = [];

      for (let i = 0; i < 4; i += 1) {
        const corner = corners[i];
        if (!clips[i]) {
          incoming.push(corner);
          outgoing.push(corner);
          polygon.push(corner);
          continue;
        }
        const previous = corners[(i + 3) % 4];
        const next = corners[(i + 1) % 4];
        const before: Point = [
          corner[0] + (previous[0] - corner[0]) * 0.1,
          corner[1] + (previous[1] - corner[1]) * 0.1,
        ];
        const after: Point = [
          corner[0] + (next[0] - corner[0]) * 0.1,
          corner[1] + (next[1] - corner[1]) * 0.1,
        ];
        // A diagonal gap must survive float32 serialization. Otherwise the
        // shells could touch again at a non-manifold point after STL import.
        if (
          (Math.fround(before[0]) === Math.fround(corner[0]) &&
            Math.fround(before[1]) === Math.fround(corner[1])) ||
          (Math.fround(after[0]) === Math.fround(corner[0]) &&
            Math.fround(after[1]) === Math.fround(corner[1]))
        ) {
          throw new RangeError('STL scale is too fine to preserve diagonal gaps; enlarge pixelSizeMm');
        }
        incoming.push(before);
        outgoing.push(after);
        polygon.push(before, after);
      }

      // A convex tile remains convex after trimming diagonal-only corners.
      // Fan triangulation therefore covers each cap without filling a hole.
      for (let i = 1; i < polygon.length - 1; i += 1) {
        const a = polygon[0], b = polygon[i], c = polygon[i + 1];
        triangle([a[0], a[1], thicknessMm], [b[0], b[1], thicknessMm], [c[0], c[1], thicknessMm]);
        triangle([a[0], a[1], 0], [c[0], c[1], 0], [b[0], b[1], 0]);
      }

      for (let i = 0; i < 4; i += 1) {
        if (clips[i]) wall(incoming[i], outgoing[i]);
        if (exposed[i]) wall(outgoing[i], incoming[(i + 1) % 4]);
      }
    }
  }

  if (offset !== buffer.byteLength) {
    throw new Error('STL triangle count did not match the generated mesh');
  }
  return new Uint8Array(buffer);
}
