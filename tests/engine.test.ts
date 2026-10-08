import assert from 'node:assert/strict';
import { test } from 'node:test';
import { exportDxf, exportGcode, exportSvg, vectorizeImageData } from '../src/engine/index.ts';

function imageFromRows(rows: string[]) {
  const height = rows.length;
  const width = rows[0].length;
  const data = new Uint8ClampedArray(width * height * 4);
  for (let y = 0; y < height; y += 1) {
    assert.equal(rows[y].length, width);
    for (let x = 0; x < width; x += 1) {
      const offset = (y * width + x) * 4;
      const channel = rows[y][x] === '#' ? 0 : 255;
      data.set([channel, channel, channel, 255], offset);
    }
  }
  return { width, height, data };
}

test('a solid ring traces a distinct outer edge and hole with the expected areas', () => {
  const result = vectorizeImageData(imageFromRows(['###', '#.#', '###']));
  assert.equal(result.contours.length, 2);
  assert.deepEqual(result.contours.map((contour) => [contour.hole, contour.areaPx]),
    [[false, 9], [true, -1]]);
  assert.deepEqual([...result.mask], [1, 1, 1, 1, 0, 1, 1, 1, 1]);
  assert.equal(result.contours[0].points.length, 4);
  assert.equal(result.contours[1].points.length, 4);
});

test('diagonal pixels remain separate 4-connected islands', () => {
  const result = vectorizeImageData(imageFromRows(['#.', '.#']));
  assert.equal(result.contours.length, 2);
  assert.ok(result.contours.every((contour) => !contour.hole && contour.areaPx === 1));
});

test('all 512 three-by-three masks conserve their selected pixel area', () => {
  for (let pattern = 0; pattern < 512; pattern += 1) {
    const rows = [0, 1, 2].map((y) => [0, 1, 2]
      .map((x) => pattern & (1 << (y * 3 + x)) ? '#' : '.').join(''));
    const result = vectorizeImageData(imageFromRows(rows));
    const foregroundPixels = [...result.mask].reduce((sum, pixel) => sum + pixel, 0);
    const contourArea = result.contours.reduce((sum, contour) => sum + contour.areaPx, 0);
    assert.equal(contourArea, foregroundPixels, `pattern ${pattern}`);
    assert.ok(result.contours.every((contour) => contour.points.length >= 3), `pattern ${pattern}`);
  }
});

test('small isolated foreground is removed from both mask and vector output', () => {
  const result = vectorizeImageData(imageFromRows(['#...', '..##']), { minArea: 2 });
  assert.equal(result.mask[0], 0);
  assert.equal(result.mask[6], 1);
  assert.equal(result.mask[7], 1);
  assert.equal(result.contours.length, 1);
  assert.equal(result.contours[0].areaPx, 2);
});

test('transparent pixels remain empty when inverted', () => {
  const data = new Uint8ClampedArray([0, 0, 0, 0, 255, 255, 255, 255]);
  const result = vectorizeImageData({ width: 2, height: 1, data }, { invert: true });
  assert.deepEqual([...result.mask], [0, 1]);
});

test('SVG keeps image Y-down coordinates and both ring paths', () => {
  const result = vectorizeImageData(imageFromRows(['###', '#.#', '###']));
  const svg = exportSvg(result, { scale: 2, fill: 'black' });
  assert.match(svg, /width="6" height="6" viewBox="0 0 3 3"/);
  assert.match(svg, /fill-rule="evenodd"/);
  assert.equal((svg.match(/ Z/g) ?? []).length, 2);
  const physicalSvg = exportSvg(result, { scale: 4, unit: 'mm' });
  assert.match(physicalSvg, /width="12mm" height="12mm" viewBox="0 0 3 3"/);
});

test('DXF declares millimetres, closed outer and hole polylines, and Y-up coordinates', () => {
  const result = vectorizeImageData(imageFromRows(['###', '#.#', '###']));
  const dxf = exportDxf(result, { mmPerPixel: 2 });
  assert.match(dxf, /\$INSUNITS\r\n70\r\n4/);
  assert.equal((dxf.match(/0\r\nLWPOLYLINE\r\n/g) ?? []).length, 2);
  assert.match(dxf, /100\r\nAcDbEntity\r\n8\r\nOUTER\r\n100\r\nAcDbPolyline\r\n90\r\n4\r\n70\r\n1\r\n10\r\n0\r\n20\r\n6/);
  assert.match(dxf, /8\r\nHOLE\r\n100\r\nAcDbPolyline\r\n90\r\n4\r\n70\r\n1/);
  assert.match(dxf, /10\r\n6\r\n20\r\n0/);
});

test('G-code cuts the hole first and explicitly closes every XY path before retracting', () => {
  const result = vectorizeImageData(imageFromRows(['###', '#.#', '###']));
  const gcode = exportGcode(result, {
    mmPerPixel: 2, safeZ: 4, cutZ: -0.8, feedRate: 240,
    plungeRate: 80, spindleRpm: 9000,
  });
  assert.match(gcode, /G21\nG90\nG17\nG94/);
  assert.match(gcode, /M3 S9000/);
  assert.ok(gcode.indexOf('(Contour 1: hole)') < gcode.indexOf('(Contour 2: outer)'));
  assert.match(gcode, /G1 Z-0\.8 F80/);
  assert.match(gcode, /G1 X\d+ Y\d+ F240/);
  const blocks = gcode.split(/\(Contour \d+: (?:hole|outer)\)\n/).slice(1);
  assert.equal(blocks.length, 2);
  for (const block of blocks) {
    const moves = block.split('\n');
    const start = moves.find((line) => /^G0 X/.test(line)).replace(/^G0 /, '');
    const retract = moves.findIndex((line) => line === 'G0 Z4');
    assert.ok(retract > 0);
    assert.equal(moves[retract - 1], `G1 ${start}`);
  }
  assert.match(gcode, /M5\nM2\n$/);
});

test('unsafe or nonsensical physical settings are rejected', () => {
  const result = vectorizeImageData(imageFromRows(['#']));
  assert.throws(() => exportGcode(result, { safeZ: 0 }), /safeZ/);
  assert.throws(() => exportGcode(result, { cutZ: 1 }), /cutZ/);
  assert.throws(() => exportGcode(result, { cutZ: 0 }), /cutZ/);
  assert.throws(() => exportGcode(result, { feedRate: 0 }), /feedRate/);
  assert.throws(() => exportGcode(result, { plungeRate: Number.NaN }), /plungeRate/);
  assert.throws(() => exportDxf(result, { mmPerPixel: 0 }), /mmPerPixel/);
});

test('incomplete or oversized RGBA input is rejected before edge allocation', () => {
  assert.throws(() => vectorizeImageData({ width: 2, height: 2, data: [0] }), /incomplete/);
  assert.throws(() => vectorizeImageData({ width: 3000, height: 3000, data: [] }), /limit/);
});
