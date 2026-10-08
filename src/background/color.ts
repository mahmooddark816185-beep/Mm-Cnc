/** RGB values and RGBA bytes use the same 0–255 range as ImageData. */
export type RGB = readonly [number, number, number];

export interface ColorImageData {
  readonly width: number;
  readonly height: number;
  readonly data: Uint8Array | Uint8ClampedArray;
}

export interface ColorBackgroundOptions {
  /** Omit to estimate the dominant visible color along the image boundary. */
  color?: RGB;
  /** RGB root-mean-square distance removed completely, from 0 to 255. Default: 24. */
  tolerance?: number;
  /** Additional distance over which the original alpha fades back in. Default: 16. */
  softness?: number;
  /** Only remove background connected to the outer boundary. Default: true. */
  contiguous?: boolean;
}

function validateImage(image: ColorImageData): number {
  const { width, height, data } = image;
  if (!Number.isSafeInteger(width) || !Number.isSafeInteger(height) ||
    width < 1 || height < 1 || width > 16_000_000 / height ||
    data.length !== width * height * 4) {
    throw new RangeError('Expected complete RGBA pixels for an image of at most 16 megapixels.');
  }
  return width * height;
}

function boundaryPixel(position: number, width: number, height: number): number {
  if (height === 1) return position;
  if (width === 1) return position * width;
  if (position < width) return position;
  position -= width;
  if (position < height - 1) return (position + 1) * width + width - 1;
  position -= height - 1;
  if (position < width - 1) return (height - 1) * width + width - 2 - position;
  position -= width - 1;
  return (height - 2 - position) * width;
}

function perimeterLength(width: number, height: number): number {
  return width === 1 ? height : height === 1 ? width : 2 * width + 2 * height - 4;
}

/**
 * Detect a dominant border color instead of averaging background and foreground
 * together. Transparent pixels carry no vote. Returns null for an already
 * transparent boundary, where guessing a color could erase the subject.
 */
export function detectBackgroundColor(image: ColorImageData): RGB | null {
  validateImage(image);
  const { width, height, data } = image;
  const perimeter = perimeterLength(width, height);
  const step = Math.max(1, Math.ceil(perimeter / 4096));
  // Fixed-size histogram: weight, red sum, green sum, blue sum per 4-bit RGB bin.
  const histogram = new Float64Array(4096 * 4);
  let winner = -1;
  let bestWeight = 0;
  for (let edge = 0; edge < perimeter; edge += step) {
    const offset = boundaryPixel(edge, width, height) * 4;
    const alpha = data[offset + 3] / 255;
    if (alpha === 0) continue;
    const weight = alpha * alpha;
    const bin = (((data[offset] >> 4) << 8) |
      ((data[offset + 1] >> 4) << 4) | (data[offset + 2] >> 4)) * 4;
    histogram[bin] += weight;
    histogram[bin + 1] += data[offset] * weight;
    histogram[bin + 2] += data[offset + 1] * weight;
    histogram[bin + 3] += data[offset + 2] * weight;
    if (histogram[bin] > bestWeight) {
      bestWeight = histogram[bin];
      winner = bin;
    }
  }
  if (winner === -1) return null;
  const seed = [histogram[winner + 1] / bestWeight,
    histogram[winner + 2] / bestWeight, histogram[winner + 3] / bestWeight];
  let weightSum = 0;
  let red = 0;
  let green = 0;
  let blue = 0;
  // Merge close samples across histogram-bin boundaries (JPEG noise, off-white).
  for (let edge = 0; edge < perimeter; edge += step) {
    const offset = boundaryPixel(edge, width, height) * 4;
    const dr = data[offset] - seed[0];
    const dg = data[offset + 1] - seed[1];
    const db = data[offset + 2] - seed[2];
    if (dr * dr + dg * dg + db * db > 3 * 20 * 20) continue;
    const weight = (data[offset + 3] / 255) ** 2;
    weightSum += weight;
    red += data[offset] * weight;
    green += data[offset + 1] * weight;
    blue += data[offset + 2] * weight;
  }
  return [Math.round(red / weightSum), Math.round(green / weightSum), Math.round(blue / weightSum)];
}

function range(value: number, name: string): number {
  if (!Number.isFinite(value) || value < 0 || value > 255) {
    throw new RangeError(`${name} must be between 0 and 255.`);
  }
  return value;
}

/**
 * Return new RGBA bytes at the original dimensions. RGB is never changed and
 * output alpha never exceeds input alpha. Interior areas of the same color are
 * preserved by default; contiguous:false also removes enclosed holes.
 *
 * The connected mode uses a one-bit visited map and a stack of horizontal runs,
 * rather than a full-resolution floating-point mask or a queue for every pixel.
 */
export function removeColorBackground(
  image: ColorImageData,
  options: ColorBackgroundOptions = {},
): Uint8ClampedArray {
  const pixelCount = validateImage(image);
  const tolerance = range(options.tolerance ?? 24, 'Tolerance');
  const softness = range(options.softness ?? 16, 'Softness');
  const color = options.color ?? detectBackgroundColor(image);
  if (color && (color.length !== 3 || color.some((channel) =>
    !Number.isFinite(channel) || channel < 0 || channel > 255))) {
    throw new RangeError('Background color must contain three RGB values between 0 and 255.');
  }
  const { width, height, data } = image;
  const output = new Uint8ClampedArray(data);
  if (!color) return output;
  const [red, green, blue] = color;
  const innerSquared = 3 * tolerance * tolerance;
  const outer = tolerance + softness;
  const outerSquared = 3 * outer * outer;

  function distanceSquared(pixel: number): number {
    const offset = pixel * 4;
    const dr = data[offset] - red;
    const dg = data[offset + 1] - green;
    const db = data[offset + 2] - blue;
    return dr * dr + dg * dg + db * db;
  }

  function eligible(pixel: number): boolean {
    if (data[pixel * 4 + 3] === 0) return true;
    const squared = distanceSquared(pixel);
    return squared <= innerSquared || squared < outerSquared;
  }

  function fade(pixel: number): void {
    const offset = pixel * 4 + 3;
    if (data[offset] === 0) return;
    const squared = distanceSquared(pixel);
    if (squared <= innerSquared) {
      output[offset] = 0;
    } else if (softness > 0 && squared < outerSquared) {
      const t = (Math.sqrt(squared / 3) - tolerance) / softness;
      output[offset] = Math.round(data[offset] * t * t * (3 - 2 * t));
    }
  }

  if (options.contiguous === false) {
    for (let pixel = 0; pixel < pixelCount; pixel += 1) fade(pixel);
    return output;
  }

  const visited = new Uint8Array(Math.ceil(pixelCount / 8));
  const wasVisited = (pixel: number): boolean => (visited[pixel >> 3] & (1 << (pixel & 7))) !== 0;
  // Chunks avoid copying an ever-growing stack, and consume only 16 KB when the
  // background is a single region. Each entry represents a whole horizontal run.
  const blockSize = 4096;
  const stack: Uint32Array[] = [];
  let stackLength = 0;
  function push(pixel: number): void {
    const block = Math.floor(stackLength / blockSize);
    stack[block] ??= new Uint32Array(blockSize);
    stack[block][stackLength % blockSize] = pixel;
    stackLength += 1;
  }

  function fillRun(pixel: number): number {
    if (wasVisited(pixel) || !eligible(pixel)) return pixel;
    const rowStart = Math.floor(pixel / width) * width;
    const rowEnd = rowStart + width;
    let left = pixel;
    let right = pixel + 1;
    while (left > rowStart && eligible(left - 1)) left -= 1;
    while (right < rowEnd && eligible(right)) right += 1;
    for (let current = left; current < right; current += 1) {
      visited[current >> 3] |= 1 << (current & 7);
      fade(current);
    }
    push(left);
    return right - 1;
  }

  const perimeter = perimeterLength(width, height);
  for (let edge = 0; edge < perimeter; edge += 1) {
    fillRun(boundaryPixel(edge, width, height));
    // Finish this component before seeding another edge, avoiding a large stack
    // of perimeter seeds for very tall or very wide images.
    while (stackLength > 0) {
      stackLength -= 1;
      const start = stack[Math.floor(stackLength / blockSize)][stackLength % blockSize];
      const rowEnd = (Math.floor(start / width) + 1) * width;
      let end = start + 1;
      // Every run was marked in full when queued; an unvisited pixel ends the run.
      while (end < rowEnd && wasVisited(end)) end += 1;
      if (start >= width) {
        for (let pixel = start - width; pixel < end - width; pixel += 1) pixel = fillRun(pixel);
      }
      if (start < (height - 1) * width) {
        for (let pixel = start + width; pixel < end + width; pixel += 1) pixel = fillRun(pixel);
      }
    }
  }
  return output;
}
