/**
 * Browser-side outline extraction for high-contrast raster artwork.
 * Coordinates in VectorResult and SVG use the image's top-left, Y-down origin.
 * DXF and G-code use a bottom-left, Y-up origin and millimetres.
 */

export interface ImageDataLike {
  readonly width: number;
  readonly height: number;
  readonly data: ArrayLike<number>;
}

export interface Point {
  readonly x: number;
  readonly y: number;
}

export interface Contour {
  /** Closed implicitly; the first point is not repeated at the end. */
  readonly points: Point[];
  /** True for the boundary of an unfilled region surrounded by artwork. */
  readonly hole: boolean;
  /** Signed area in square pixels, positive for outer contours in Y-down space. */
  readonly areaPx: number;
}

export interface VectorResult {
  readonly width: number;
  readonly height: number;
  /** Row-major, exactly width * height entries; 1 is artwork and 0 is empty. */
  readonly mask: Uint8Array;
  readonly contours: Contour[];
}

export interface VectorizeOptions {
  /** Composite transparent pixels over white, then select darker pixels below this value. Default 128. */
  readonly threshold?: number;
  /** Select lighter pixels instead; fully transparent pixels always remain empty. */
  readonly invert?: boolean;
  /** Remove foreground islands smaller than this many connected pixels. Default 1. */
  readonly minArea?: number;
  /** Optional outline simplification in pixel units; 0 preserves all corner geometry. Default 0. */
  readonly simplifyTolerance?: number;
}

export interface SvgOptions {
  /** Display scale. The SVG viewBox stays in pixel coordinates. Default 1. */
  readonly scale?: number;
  /** Optional physical dimension suffix for width and height. */
  readonly unit?: 'mm' | 'px';
  readonly strokeWidth?: number;
  readonly stroke?: string;
  readonly fill?: string;
}

export interface DxfOptions {
  /** Physical size of one source pixel in millimetres. Default 1. */
  readonly mmPerPixel?: number;
}

export interface GcodeOptions extends DxfOptions {
  /** Clearance plane relative to stock top, in millimetres. Default +5. */
  readonly safeZ?: number;
  /** Cutting depth relative to stock top, in millimetres. Default -1. */
  readonly cutZ?: number;
  /** XY cutting feed in mm/min. Default 300. */
  readonly feedRate?: number;
  /** Z plunge feed in mm/min. Default 100. */
  readonly plungeRate?: number;
  /** Spindle speed in RPM. Default 10000. */
  readonly spindleRpm?: number;
}

type Direction = 0 | 1 | 2 | 3; // east, south, west, north in image coordinates
type Edge = { from: number; to: number; direction: Direction; used: boolean };

const MAX_PIXELS = 4_000_000;
const MAX_EDGES = 1_000_000;

function finiteInRange(value: number, name: string, min: number, max = Number.POSITIVE_INFINITY): number {
  if (!Number.isFinite(value) || value < min || value > max) {
    throw new RangeError(`${name} must be a finite number between ${min} and ${max}.`);
  }
  return value;
}

function positiveInteger(value: number, name: string): number {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new RangeError(`${name} must be a positive safe integer.`);
  }
  return value;
}

function signedArea(points: readonly Point[]): number {
  let twiceArea = 0;
  for (let i = 0; i < points.length; i += 1) {
    const a = points[i];
    const b = points[(i + 1) % points.length];
    twiceArea += a.x * b.y - b.x * a.y;
  }
  return twiceArea / 2;
}

function withoutCollinearVertices(points: readonly Point[]): Point[] {
  if (points.length <= 3) return [...points];
  return points.filter((current, i) => {
    const previous = points[(i - 1 + points.length) % points.length];
    const next = points[(i + 1) % points.length];
    const cross = (current.x - previous.x) * (next.y - current.y)
      - (current.y - previous.y) * (next.x - current.x);
    return cross !== 0;
  });
}

function squaredDistanceToSegment(point: Point, start: Point, end: Point): number {
  const dx = end.x - start.x;
  const dy = end.y - start.y;
  const lengthSquared = dx * dx + dy * dy;
  if (lengthSquared === 0) {
    return (point.x - start.x) ** 2 + (point.y - start.y) ** 2;
  }
  const t = Math.max(0, Math.min(1,
    ((point.x - start.x) * dx + (point.y - start.y) * dy) / lengthSquared));
  return (point.x - start.x - t * dx) ** 2 + (point.y - start.y - t * dy) ** 2;
}

function simplifyOpen(points: readonly Point[], toleranceSquared: number): Point[] {
  if (points.length <= 2) return [...points];
  const keep = new Uint8Array(points.length);
  keep[0] = 1;
  keep[points.length - 1] = 1;
  const segments: Array<[number, number]> = [[0, points.length - 1]];
  while (segments.length > 0) {
    const [first, last] = segments.pop()!;
    let farthest = -1;
    let greatestDistance = toleranceSquared;
    for (let i = first + 1; i < last; i += 1) {
      const distance = squaredDistanceToSegment(points[i], points[first], points[last]);
      if (distance > greatestDistance) {
        greatestDistance = distance;
        farthest = i;
      }
    }
    if (farthest >= 0) {
      keep[farthest] = 1;
      segments.push([first, farthest], [farthest, last]);
    }
  }
  return points.filter((_, i) => keep[i] === 1);
}

function simplifyClosed(points: readonly Point[], tolerance: number): Point[] {
  if (tolerance <= 0 || points.length <= 3) return [...points];
  let farthest = 1;
  let greatestDistance = -1;
  for (let i = 1; i < points.length; i += 1) {
    const distance = (points[i].x - points[0].x) ** 2 + (points[i].y - points[0].y) ** 2;
    if (distance > greatestDistance) {
      greatestDistance = distance;
      farthest = i;
    }
  }
  const arcA = simplifyOpen(points.slice(0, farthest + 1), tolerance ** 2);
  const arcB = simplifyOpen([...points.slice(farthest), points[0]], tolerance ** 2);
  const simplified = [...arcA.slice(0, -1), ...arcB.slice(0, -1)];
  if (simplified.length < 3 || signedArea(simplified) === 0) return [...points];
  // Excessive simplification can turn a tight notch or hole inside out.
  if (Math.sign(signedArea(simplified)) !== Math.sign(signedArea(points))) return [...points];
  return simplified;
}

function discardSmallIslands(mask: Uint8Array, width: number, height: number, minArea: number): void {
  if (minArea <= 1) return;
  const queue = new Int32Array(mask.length);
  for (let start = 0; start < mask.length; start += 1) {
    if (mask[start] !== 1) continue;
    let read = 0;
    let count = 1;
    queue[0] = start;
    mask[start] = 2;
    while (read < count) {
      const index = queue[read++];
      const x = index % width;
      const y = Math.floor(index / width);
      const neighbours = [
        x > 0 ? index - 1 : -1,
        x + 1 < width ? index + 1 : -1,
        y > 0 ? index - width : -1,
        y + 1 < height ? index + width : -1,
      ];
      for (const neighbour of neighbours) {
        if (neighbour >= 0 && mask[neighbour] === 1) {
          mask[neighbour] = 2;
          queue[count++] = neighbour;
        }
      }
    }
    if (count < minArea) {
      for (let i = 0; i < count; i += 1) mask[queue[i]] = 0;
    }
  }
  for (let i = 0; i < mask.length; i += 1) {
    if (mask[i] === 2) mask[i] = 1;
  }
}

/** Rasterize the RGBA pixels to a binary mask and trace 4-connected cell edges. */
export function vectorizeImageData(imageData: ImageDataLike, options: VectorizeOptions = {}): VectorResult {
  const width = positiveInteger(imageData.width, 'width');
  const height = positiveInteger(imageData.height, 'height');
  const pixelCount = width * height;
  if (!Number.isSafeInteger(pixelCount) || pixelCount > MAX_PIXELS) {
    throw new RangeError(`Image exceeds the ${MAX_PIXELS} pixel limit; reduce its resolution first.`);
  }
  if (!imageData.data || imageData.data.length < pixelCount * 4) {
    throw new RangeError('RGBA image data is incomplete.');
  }
  const threshold = finiteInRange(options.threshold ?? 128, 'threshold', 0, 255);
  const minArea = positiveInteger(options.minArea ?? 1, 'minArea');
  const tolerance = finiteInRange(options.simplifyTolerance ?? 0, 'simplifyTolerance', 0, 100);
  const mask = new Uint8Array(pixelCount);
  for (let i = 0; i < pixelCount; i += 1) {
    const offset = i * 4;
    const alpha = imageData.data[offset + 3] / 255;
    if (alpha <= 0) continue;
    const colourLuma = imageData.data[offset] * 0.2126
      + imageData.data[offset + 1] * 0.7152
      + imageData.data[offset + 2] * 0.0722;
    const whiteCompositedLuma = colourLuma * alpha + 255 * (1 - alpha);
    const selected = options.invert ? whiteCompositedLuma >= threshold : whiteCompositedLuma < threshold;
    mask[i] = selected ? 1 : 0;
  }
  discardSmallIslands(mask, width, height, minArea);

  const vertexWidth = width + 1;
  const edges: Edge[] = [];
  const outgoing = new Map<number, number[]>();
  const vertex = (x: number, y: number): number => y * vertexWidth + x;
  const add = (from: number, to: number, direction: Direction): void => {
    if (edges.length >= MAX_EDGES) {
      throw new RangeError(`Artwork exceeds the ${MAX_EDGES} edge limit; simplify or reduce its resolution.`);
    }
    const index = edges.length;
    edges.push({ from, to, direction, used: false });
    const candidates = outgoing.get(from);
    if (candidates) candidates.push(index);
    else outgoing.set(from, [index]);
  };

  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const index = y * width + x;
      if (!mask[index]) continue;
      if (y === 0 || !mask[index - width]) add(vertex(x, y), vertex(x + 1, y), 0);
      if (x === width - 1 || !mask[index + 1]) add(vertex(x + 1, y), vertex(x + 1, y + 1), 1);
      if (y === height - 1 || !mask[index + width]) add(vertex(x + 1, y + 1), vertex(x, y + 1), 2);
      if (x === 0 || !mask[index - 1]) add(vertex(x, y + 1), vertex(x, y), 3);
    }
  }

  const contours: Contour[] = [];
  for (let first = 0; first < edges.length; first += 1) {
    if (edges[first].used) continue;
    const firstVertex = edges[first].from;
    const points: Point[] = [];
    let edgeIndex = first;
    let traversed = 0;
    while (true) {
      const edge = edges[edgeIndex];
      if (edge.used || traversed++ > edges.length) {
        throw new Error('Unable to close an image contour.');
      }
      edge.used = true;
      points.push({ x: edge.from % vertexWidth, y: Math.floor(edge.from / vertexWidth) });
      if (edge.to === firstVertex) break;
      const candidates = (outgoing.get(edge.to) ?? []).filter((candidate) => !edges[candidate].used);
      if (candidates.length === 0) throw new Error('Image contour has an open boundary.');
      // At a diagonal touch, a right turn keeps each 4-connected island separate.
      const turnRank = (candidate: number): number => {
        const turn = (edges[candidate].direction - edge.direction + 4) % 4;
        return [1, 0, 2, 3][turn]; // right, straight, left, back
      };
      candidates.sort((a, b) => turnRank(a) - turnRank(b));
      edgeIndex = candidates[0];
    }
    const cleanPoints = withoutCollinearVertices(points);
    const simplified = simplifyClosed(cleanPoints, tolerance);
    const areaPx = signedArea(simplified);
    if (simplified.length >= 3 && areaPx !== 0) {
      contours.push({ points: simplified, hole: areaPx < 0, areaPx });
    }
  }
  return { width, height, mask, contours };
}

function formatNumber(value: number): string {
  return Object.is(value, -0) || Math.abs(value) < 0.0000005
    ? '0'
    : String(Number(value.toFixed(6)));
}

function xmlAttribute(value: string): string {
  return value.replaceAll('&', '&amp;').replaceAll('"', '&quot;')
    .replaceAll('<', '&lt;').replaceAll('>', '&gt;');
}

function positiveScale(value: number, name: string): number {
  return finiteInRange(value, name, 0.000001, 1_000_000);
}

function validateResult(result: VectorResult): void {
  if (!Number.isSafeInteger(result.width) || result.width <= 0
    || !Number.isSafeInteger(result.height) || result.height <= 0
    || result.mask.length !== result.width * result.height) {
    throw new RangeError('Invalid vector dimensions or mask.');
  }
  for (const contour of result.contours) {
    if (contour.points.length < 3 || contour.points.some(
      (point) => !Number.isFinite(point.x) || !Number.isFinite(point.y))) {
      throw new RangeError('Invalid contour coordinates.');
    }
  }
}

/** SVG keeps the image's top-left, Y-down coordinate system. */
export function exportSvg(result: VectorResult, options: SvgOptions = {}): string {
  validateResult(result);
  const scale = positiveScale(options.scale ?? 1, 'scale');
  const strokeWidth = positiveScale(options.strokeWidth ?? 1, 'strokeWidth');
  const paths = result.contours.map((contour) => {
    const [first, ...remaining] = contour.points;
    return `M ${formatNumber(first.x)} ${formatNumber(first.y)} ${remaining.map(
      (point) => `L ${formatNumber(point.x)} ${formatNumber(point.y)}`).join(' ')} Z`;
  });
  return [
    '<?xml version="1.0" encoding="UTF-8"?>',
    `<svg xmlns="http://www.w3.org/2000/svg" width="${formatNumber(result.width * scale)}${options.unit ?? ''}" height="${formatNumber(result.height * scale)}${options.unit ?? ''}" viewBox="0 0 ${result.width} ${result.height}">`,
    `  <path d="${paths.join(' ')}" fill="${xmlAttribute(options.fill ?? 'none')}" fill-rule="evenodd" stroke="${xmlAttribute(options.stroke ?? '#111827')}" stroke-width="${formatNumber(strokeWidth)}" stroke-linejoin="round"/>`,
    '</svg>',
    '',
  ].join('\n');
}

/** AutoCAD-compatible DXF LWPOLYLINE contours, Y-up and in millimetres. */
export function exportDxf(result: VectorResult, options: DxfOptions = {}): string {
  validateResult(result);
  const mmPerPixel = positiveScale(options.mmPerPixel ?? 1, 'mmPerPixel');
  const lines = [
    '0', 'SECTION', '2', 'HEADER',
    '9', '$ACADVER', '1', 'AC1015',
    '9', '$INSUNITS', '70', '4',
    '9', '$MEASUREMENT', '70', '1',
    '0', 'ENDSEC',
    '0', 'SECTION', '2', 'TABLES',
    '0', 'TABLE', '2', 'LAYER', '5', '2', '70', '2',
    '0', 'LAYER', '2', 'OUTER', '70', '0', '62', '7', '6', 'CONTINUOUS',
    '0', 'LAYER', '2', 'HOLE', '70', '0', '62', '1', '6', 'CONTINUOUS',
    '0', 'ENDTAB', '0', 'ENDSEC',
    '0', 'SECTION', '2', 'ENTITIES',
  ];
  for (const contour of result.contours) {
    lines.push('0', 'LWPOLYLINE', '100', 'AcDbEntity',
      '8', contour.hole ? 'HOLE' : 'OUTER', '100', 'AcDbPolyline',
      '90', String(contour.points.length), '70', '1');
    for (const point of contour.points) {
      lines.push('10', formatNumber(point.x * mmPerPixel),
        '20', formatNumber((result.height - point.y) * mmPerPixel));
    }
  }
  lines.push('0', 'ENDSEC', '0', 'EOF', '');
  return lines.join('\r\n');
}

/**
 * Generic single-pass, centreline 2.5D contour program. The operator must
 * simulate and adapt it for their machine, stock, tooling and work origin.
 */
export function exportGcode(result: VectorResult, options: GcodeOptions = {}): string {
  validateResult(result);
  const mmPerPixel = positiveScale(options.mmPerPixel ?? 1, 'mmPerPixel');
  const safeZ = finiteInRange(options.safeZ ?? 5, 'safeZ', 0.000001, 100_000);
  const cutZ = options.cutZ ?? -1;
  if (!Number.isFinite(cutZ) || cutZ >= 0 || cutZ < -100_000) {
    throw new RangeError('cutZ must be a finite negative depth in millimetres.');
  }
  const feedRate = positiveScale(options.feedRate ?? 300, 'feedRate');
  const plungeRate = positiveScale(options.plungeRate ?? 100, 'plungeRate');
  const spindleRpm = finiteInRange(options.spindleRpm ?? 10_000, 'spindleRpm', 1, 100_000);
  const coordinates = (point: Point): string =>
    `X${formatNumber(point.x * mmPerPixel)} Y${formatNumber((result.height - point.y) * mmPerPixel)}`;
  const lines = [
    '(Mm Cnc generic outline program; simulate and adapt before machining)',
    '(Origin: bottom-left of image; units: mm; image Y is flipped)',
    '(Single pass; tool centreline; no cutter compensation, pocketing or tabs)',
    `(${formatNumber(mmPerPixel)} mm per source pixel)`,
    'G21', 'G90', 'G17', 'G94',
    `G0 Z${formatNumber(safeZ)}`,
    `M3 S${formatNumber(spindleRpm)}`,
  ];
  const cutOrder = [...result.contours].sort((a, b) => {
    if (a.hole !== b.hole) return a.hole ? -1 : 1;
    return Math.abs(a.areaPx) - Math.abs(b.areaPx);
  });
  for (const [index, contour] of cutOrder.entries()) {
    const first = contour.points[0];
    lines.push(`(Contour ${index + 1}: ${contour.hole ? 'hole' : 'outer'})`);
    lines.push(`G0 ${coordinates(first)}`);
    lines.push(`G1 Z${formatNumber(cutZ)} F${formatNumber(plungeRate)}`);
    for (const [pointIndex, point] of contour.points.slice(1).entries()) {
      lines.push(`G1 ${coordinates(point)}${pointIndex === 0 ? ` F${formatNumber(feedRate)}` : ''}`);
    }
    lines.push(`G1 ${coordinates(first)}`);
    lines.push(`G0 Z${formatNumber(safeZ)}`);
  }
  lines.push('M5', 'M2', '');
  return lines.join('\n');
}
