import { degrees } from 'pdf-lib';

// ISO 32000-1:2008, retrieved 2026-11-27.
// https://opensource.adobe.com/dc-acrobat-sdk-docs/pdfstandards/PDF32000_2008.pdf

function boxEdges({ x, y, width, height }) {
  // A rectangle can be specified by either pair of opposite corners (§7.9.5).
  return {
    left: Math.min(x, x + width),
    bottom: Math.min(y, y + height),
    right: Math.max(x, x + width),
    top: Math.max(y, y + height),
  };
}

function visibleBox(page) {
  const media = boxEdges(page.getMediaBox());
  const crop = boxEdges(page.getCropBox()); // pdf-lib falls back to the MediaBox.
  // The effective CropBox is limited by the MediaBox (§14.11.2).
  const left = Math.max(media.left, crop.left);
  const bottom = Math.max(media.bottom, crop.bottom);
  const right = Math.min(media.right, crop.right);
  const top = Math.min(media.top, crop.top);
  // Follow PDF.js for an empty intersection (v6.5.438, retrieved 2026-11-27).
  // https://github.com/mozilla/pdf.js/blob/v6.5.438/src/core/document.js#L234-L248
  const box = left < right && bottom < top ? { left, bottom, right, top } : media;
  return { x: box.left, y: box.bottom, width: box.right - box.left, height: box.top - box.bottom };
}

/** Map distances from the visible bottom-left corner into PDF user space. */
export function visiblePage(page) {
  const { x, y, width, height } = visibleBox(page);
  const angle = ((page.getRotation().angle % 360) + 360) % 360;
  // /Rotate is clockwise when displayed (Table 30), so draw counterclockwise.
  switch (angle) {
    case 90:
      return {
        width: height,
        height: width,
        rotate: degrees(angle),
        point: (left, bottom) => ({ x: x + width - bottom, y: y + left }),
      };
    case 180:
      return {
        width,
        height,
        rotate: degrees(angle),
        point: (left, bottom) => ({ x: x + width - left, y: y + height - bottom }),
      };
    case 270:
      return {
        width: height,
        height: width,
        rotate: degrees(angle),
        point: (left, bottom) => ({ x: x + bottom, y: y + height - left }),
      };
    default:
      return {
        width,
        height,
        rotate: degrees(0),
        point: (left, bottom) => ({ x: x + left, y: y + bottom }),
      };
  }
}
