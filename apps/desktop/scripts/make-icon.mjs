// Draws the desktop app's icon (a green rounded square with a white «م» mark) as PNG and ICO.
// No fonts: the letter is composed from rounded strokes so the build needs no extra tools.
import { mkdirSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { PNG } from 'pngjs';

const here = dirname(fileURLToPath(import.meta.url));
const out = join(here, '..', 'assets');
mkdirSync(out, { recursive: true });

function render(size) {
  const png = new PNG({ width: size, height: size });
  const radius = size * 0.22;
  const inside = (x, y) => {
    const cx = Math.min(Math.max(x, radius), size - radius), cy = Math.min(Math.max(y, radius), size - radius);
    return (x - cx) ** 2 + (y - cy) ** 2 <= radius ** 2;
  };
  // The mark: a ring (the loop of «م») and a tail stroke to its left, as the letter is drawn in Naskh.
  const ringX = size * 0.60, ringY = size * 0.47, ringR = size * 0.17, ringW = size * 0.085;
  const tail = (x, y) => {
    const t0x = size * 0.26, t0y = size * 0.43, t1x = size * 0.43, t1y = size * 0.64;
    const dx = t1x - t0x, dy = t1y - t0y, length2 = dx * dx + dy * dy;
    const t = Math.max(0, Math.min(1, ((x - t0x) * dx + (y - t0y) * dy) / length2));
    const px = t0x + t * dx, py = t0y + t * dy;
    return Math.hypot(x - px, y - py) <= ringW / 2;
  };
  for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) {
    const index = (size * y + x) << 2;
    const cx = x + 0.5, cy = y + 0.5;
    let r = 0, g = 0, b = 0, a = 0;
    if (inside(cx, cy)) {
      const shade = 1 - (cy / size) * 0.18;
      r = Math.round(25 * shade); g = Math.round(107 * shade); b = Math.round(86 * shade); a = 255;
      const distance = Math.hypot(cx - ringX, cy - ringY);
      const onRing = Math.abs(distance - ringR) <= ringW / 2;
      const onDot = Math.hypot(cx - size * 0.60, cy - size * 0.47) <= ringW * 0.42;
      if (onRing || tail(cx, cy) || onDot) { r = 255; g = 255; b = 255; }
    }
    png.data[index] = r; png.data[index + 1] = g; png.data[index + 2] = b; png.data[index + 3] = a;
  }
  return PNG.sync.write(png);
}

const sizes = [16, 32, 48, 64, 128, 256];
const images = sizes.map(size => ({ size, png: render(size) }));
writeFileSync(join(out, 'icon.png'), images.at(-1).png);
writeFileSync(join(out, 'tray.png'), render(32));

// ICO container with PNG-compressed entries (supported since Windows Vista).
const header = Buffer.alloc(6);
header.writeUInt16LE(0, 0); header.writeUInt16LE(1, 2); header.writeUInt16LE(images.length, 4);
const entries = [];
let offset = 6 + images.length * 16;
for (const { size, png } of images) {
  const entry = Buffer.alloc(16);
  entry.writeUInt8(size === 256 ? 0 : size, 0); entry.writeUInt8(size === 256 ? 0 : size, 1); entry.writeUInt8(0, 2); entry.writeUInt8(0, 3);
  entry.writeUInt16LE(1, 4); entry.writeUInt16LE(32, 6); entry.writeUInt32LE(png.length, 8); entry.writeUInt32LE(offset, 12);
  entries.push(entry); offset += png.length;
}
writeFileSync(join(out, 'icon.ico'), Buffer.concat([header, ...entries, ...images.map(image => image.png)]));
console.log(`icons written to ${out}`);
