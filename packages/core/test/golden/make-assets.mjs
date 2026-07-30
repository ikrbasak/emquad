// Generate the binary assets the golden fixtures reference.
//
//   node test/golden/make-assets.mjs
//
// Run once; the output is committed. Generated rather than checked in as opaque
// blobs so a reader can see exactly what the images are — a golden test whose
// inputs are unreadable is hard to reason about when it fails.
//
// The images have to be *visible*, not merely decodable. A 1x1 transparent PNG
// proves the decoder ran; it proves nothing about whether the image was placed,
// scaled, or drawn at all.

import { mkdirSync, writeFileSync } from "node:fs";
import { deflateSync } from "node:zlib";
import { fileURLToPath } from "node:url";
import { join } from "node:path";

import * as mupdf from "mupdf";

const OUT = fileURLToPath(new URL("./assets/", import.meta.url));
mkdirSync(OUT, { recursive: true });

// `>>> 0` here is an unsigned 32-bit coercion, not a truncation. `Math.trunc`
// is not a substitute: CRC-32 values above 2^31 come out of `^` as negative
// signed integers, and PNG needs the unsigned form.
// oxlint-disable unicorn/prefer-math-trunc
const crcTable = Array.from({ length: 256 }, (_, n) => {
  let c = n;
  for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xed_b8_83_20 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});

function crc32(buf) {
  let c = 0xff_ff_ff_ff;
  for (const byte of buf) c = crcTable[(c ^ byte) & 0xff] ^ (c >>> 8);
  return (c ^ 0xff_ff_ff_ff) >>> 0;
}
// oxlint-enable unicorn/prefer-math-trunc

function chunk(type, data) {
  const head = Buffer.alloc(8);
  head.writeUInt32BE(data.length, 0);
  head.write(type, 4, 4, "latin1");
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(Buffer.concat([Buffer.from(type, "latin1"), data])), 0);
  return Buffer.concat([head, data, crc]);
}

/** An RGB PNG from a `(x, y) => [r, g, b]` function. */
function png(width, height, pixel) {
  const raw = Buffer.alloc(height * (1 + width * 3));
  for (let y = 0; y < height; y += 1) {
    const row = y * (1 + width * 3);
    raw[row] = 0; // filter: none
    for (let x = 0; x < width; x += 1) {
      const [r, g, b] = pixel(x, y);
      raw[row + 1 + x * 3] = r;
      raw[row + 2 + x * 3] = g;
      raw[row + 3 + x * 3] = b;
    }
  }

  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 2; // color type: truecolor

  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", ihdr),
    chunk("IDAT", deflateSync(raw, { level: 9 })),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

// A 64x64 diagonal gradient with a solid block: enough structure that a
// mis-scaled or mis-placed image shows up as a pixel difference.
const logo = png(64, 64, (x, y) =>
  x > 40 && y > 40 ? [220, 40, 60] : [(x * 4) % 256, (y * 4) % 256, 128],
);
writeFileSync(join(OUT, "logo.png"), logo);

// JPEG, via mupdf rather than a hand-rolled encoder. Lossy compression is a
// distinct decode path in typst and worth covering separately from PNG.
const pixmap = new mupdf.Pixmap(mupdf.ColorSpace.DeviceRGB, [0, 0, 64, 64], false);
const samples = pixmap.getPixels();
for (let y = 0; y < 64; y += 1) {
  for (let x = 0; x < 64; x += 1) {
    const at = (y * 64 + x) * 3;
    samples[at] = (x * 4) % 256;
    samples[at + 1] = 200 - ((y * 3) % 200);
    samples[at + 2] = 90;
  }
}
writeFileSync(join(OUT, "photo.jpg"), Buffer.from(pixmap.asJPEG(90, false)));

// SVG: vector, with both a shape and a text run. The text matters — an SVG
// referencing a font emquad has not registered is one of the documented silent
// failure modes.
writeFileSync(
  join(OUT, "mark.svg"),
  `<svg xmlns="http://www.w3.org/2000/svg" width="80" height="40" viewBox="0 0 80 40">
  <rect x="0" y="0" width="80" height="40" fill="#1a3a5a"/>
  <circle cx="20" cy="20" r="12" fill="#ffcc33"/>
  <text x="40" y="26" font-family="Libertinus Serif" font-size="14" fill="#ffffff">SVG</text>
</svg>
`,
);

console.log("wrote logo.png, photo.jpg, mark.svg");
