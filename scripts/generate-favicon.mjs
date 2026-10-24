import { readFile, writeFile } from "node:fs/promises";
import sharp from "sharp";

const asset = (name) => new URL(`../public/${name}`, import.meta.url);
const svg = await readFile(asset("favicon.svg"));
const provenance = `<x:xmpmeta xmlns:x="adobe:ns:meta/">
  <rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#">
    <rdf:Description rdf:about="" xmlns:dc="http://purl.org/dc/elements/1.1/">
      <dc:source>PaperSign public/favicon.svg; Lucide Feather from @lucide/vue 1.61.0</dc:source>
      <dc:description>Rendered from the vector favicon with Sharp. White feather on PaperSign green.</dc:description>
      <dc:rights>Lucide Icons and Contributors; Cole Bemis. ISC/MIT; see favicon-LICENSE.txt.</dc:rights>
    </rdf:Description>
  </rdf:RDF>
</x:xmpmeta>`;
const frames = [];
for (const size of [16, 32, 48]) {
  const rgba = await sharp(svg, { density: 384 })
    .resize(size, size)
    .ensureAlpha()
    .raw()
    .toBuffer();
  const maskStride = Math.ceil(size / 32) * 4;
  const bitmap = Buffer.alloc(40 + size * size * 4 + maskStride * size);
  bitmap.writeUInt32LE(40, 0);
  bitmap.writeInt32LE(size, 4);
  bitmap.writeInt32LE(size * 2, 8);
  bitmap.writeUInt16LE(1, 12);
  bitmap.writeUInt16LE(32, 14);
  bitmap.writeUInt32LE(size * size * 4, 20);
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const source = (y * size + x) * 4;
      const target = 40 + ((size - 1 - y) * size + x) * 4;
      bitmap[target] = rgba[source + 2];
      bitmap[target + 1] = rgba[source + 1];
      bitmap[target + 2] = rgba[source];
      bitmap[target + 3] = rgba[source + 3];
      if (rgba[source + 3] === 0)
        bitmap[40 + size * size * 4 + (size - 1 - y) * maskStride + (x >> 3)] |=
          0x80 >> (x % 8);
    }
  }
  frames.push({ size, bitmap });
}

// Classic bottom-up BGRA bitmaps with AND masks also work in older icon readers.
const header = Buffer.alloc(6 + 16 * frames.length);
header.writeUInt16LE(1, 2);
header.writeUInt16LE(frames.length, 4);
let offset = header.length;
for (const [index, { size, bitmap }] of frames.entries()) {
  const entry = 6 + 16 * index;
  header[entry] = size;
  header[entry + 1] = size;
  header.writeUInt16LE(1, entry + 4);
  header.writeUInt16LE(32, entry + 6);
  header.writeUInt32LE(bitmap.length, entry + 8);
  header.writeUInt32LE(offset, entry + 12);
  offset += bitmap.length;
}
await writeFile(
  asset("favicon.ico"),
  Buffer.concat([header, ...frames.map(({ bitmap }) => bitmap)]),
);

// Home-screen icons are opaque; the device supplies its own corner mask.
const touch = Buffer.from(svg.toString().replace('rx="14"', 'rx="0"'));
await sharp(touch, { density: 384 })
  .resize(180, 180)
  .withXmp(provenance)
  .png()
  .toFile(new URL("../public/apple-touch-icon.png", import.meta.url).pathname);
