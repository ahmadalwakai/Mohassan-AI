import { decodePDFRawStream, degrees, PDFArray, PDFDocument, PDFName, PDFRawStream, StandardFonts, type PDFPage } from 'pdf-lib';
import { describe, expect, it } from 'vitest';
import { numberPages, stampPdf } from './edit.ts';

type Point = [number, number];
type Box = { x: number; y: number; width: number; height: number };

const fullPage = { x: 0, y: 0, width: 312, height: 476 };
const offsetPage = { ...fullPage, x: -48, y: 36 };
const cases: { label: string; angle: number; media: Box; crop?: Box; visible?: Box }[] = [
  ...[0, 90, 180, 270].map(angle => ({ label: `${angle}° rotation`, angle, media: fullPage })),
  { label: 'offset MediaBox', angle: 180, media: offsetPage },
  { label: 'offset CropBox', angle: 90, media: offsetPage, crop: { x: -21, y: 67, width: 241, height: 353 } },
  {
    label: 'CropBox extending beyond the MediaBox', angle: 270, media: offsetPage,
    crop: { x: offsetPage.x - 19, y: offsetPage.y, width: offsetPage.width, height: offsetPage.height + 43 },
    visible: { ...offsetPage, width: offsetPage.width - 19 },
  },
  {
    label: 'CropBox disjoint from the MediaBox', angle: 0, media: offsetPage,
    crop: { ...offsetPage, x: offsetPage.x + offsetPage.width + 5 }, visible: offsetPage,
  },
  {
    label: 'reversed rectangle corners', angle: 0,
    media: { x: offsetPage.x + offsetPage.width, y: offsetPage.y + offsetPage.height, width: -offsetPage.width, height: -offsetPage.height },
    visible: offsetPage,
  },
  { label: 'negative rotation', angle: -90, media: fullPage },
];

/** Compute displayed coordinates by rotating the box clockwise, then shifting its bounds to zero. */
function viewer(box: Box, angle: number) {
  const radians = -angle * Math.PI / 180;
  const cosine = Math.cos(radians);
  const sine = Math.sin(radians);
  const rotate = ([x, y]: Point): Point => [cosine * x - sine * y, sine * x + cosine * y];
  const right = box.x + box.width;
  const top = box.y + box.height;
  const corners = [rotate([box.x, box.y]), rotate([right, box.y]), rotate([box.x, top]), rotate([right, top])];
  const xs = corners.map(([x]) => x);
  const ys = corners.map(([, y]) => y);
  const left = Math.min(...xs);
  const bottom = Math.min(...ys);
  return {
    width: Math.max(...xs) - left,
    height: Math.max(...ys) - bottom,
    point: (point: Point): Point => {
      const [x, y] = rotate(point);
      return [x - left, y - bottom];
    },
  };
}

function contentOperators(page: PDFPage) {
  const contents = page.node.lookup(PDFName.of('Contents'), PDFArray);
  const stream = contents.lookup(contents.size() - 1, PDFRawStream);
  return new TextDecoder().decode(decodePDFRawStream(stream).decode()).trim().split('\n');
}

function matrices(operators: string[], operator: 'cm' | 'Tm') {
  return operators.filter(line => line.endsWith(` ${operator}`)).map(line => line.split(' ').slice(0, 6).map(Number));
}

function transform([a, b, c, d, e, f]: number[], [x, y]: Point): Point {
  return [a * x + c * y + e, b * x + d * y + f];
}

function expectPoint(actual: Point, expected: Point) {
  expect(actual[0]).toBeCloseTo(expected[0], 6);
  expect(actual[1]).toBeCloseTo(expected[1], 6);
}

describe('stamp and number placement in visible PDF pages', () => {
  it.each(cases)('covers the visible box and keeps its marks upright with $label', async ({ angle, media, crop, visible }) => {
    const document = await PDFDocument.create();
    const page = document.addPage();
    page.setMediaBox(media.x, media.y, media.width, media.height);
    if (crop) page.setCropBox(crop.x, crop.y, crop.width, crop.height);
    page.setRotation(degrees(angle));
    const source = await document.save();
    const display = viewer(visible ?? crop ?? media, angle);

    const stampWidth = 83;
    const stampHeight = 137;
    const overlay = await PDFDocument.create();
    overlay.addPage([stampWidth, stampHeight]).drawRectangle({ x: 0, y: 0, width: stampWidth, height: stampHeight });
    const stamped = await PDFDocument.load(await stampPdf(source, await overlay.save()));
    const stampOperators = contentOperators(stamped.getPage(0));
    expect(stampOperators.some(line => line.endsWith(' Do'))).toBe(true);
    const stampMatrices = matrices(stampOperators, 'cm');
    const stampPoint = (point: Point) => display.point(stampMatrices.reduceRight<Point>((result, matrix) => transform(matrix, result), point));
    expectPoint(stampPoint([0, 0]), [0, 0]);
    expectPoint(stampPoint([stampWidth, 0]), [display.width, 0]);
    expectPoint(stampPoint([0, stampHeight]), [0, display.height]);
    expectPoint(stampPoint([stampWidth, stampHeight]), [display.width, display.height]);

    const size = 14;
    const margin = 29;
    const start = 73;
    const numbered = await PDFDocument.load(await numberPages(source, { size, margin, start, total: false }));
    const textOperators = contentOperators(numbered.getPage(0));
    const [textMatrix] = matrices(textOperators, 'Tm');
    const font = await document.embedFont(StandardFonts.Helvetica);
    const text = String(start);
    expect(textOperators).toContain(`${font.encodeText(text)} Tj`);
    const halfTextWidth = font.widthOfTextAtSize(text, size) / 2;
    const center = display.width / 2;
    const textPoint = (point: Point) => display.point(transform(textMatrix, point));
    expectPoint(textPoint([halfTextWidth, 0]), [center, margin]);
    expectPoint(textPoint([0, 0]), [center - halfTextWidth, margin]);
    expectPoint(textPoint([halfTextWidth, size]), [center, margin + size]);
  });
});
