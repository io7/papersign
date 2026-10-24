import { PDFDocument, StandardFonts, degrees, rgb } from "pdf-lib";
import sharp from "sharp";
export async function signaturePng() {
  return sharp({
    create: {
      width: 240,
      height: 80,
      channels: 4,
      background: { r: 0, g: 0, b: 0, alpha: 0 },
    },
  })
    .composite([
      {
        input: Buffer.from(
          '<svg width="240" height="80"><path d="M12 58 C28 45 30 6 40 17 S34 78 60 48 S80 20 88 40 S106 57 127 28 S142 76 166 44 L225 43" stroke="#db2626" fill="none" stroke-width="5"/></svg>',
        ),
      },
    ])
    .png()
    .toBuffer();
}
export async function whiteSignaturePng(transparent = false) {
  const width = 80,
    height = 40;
  const pixels = Buffer.alloc(width * height * 4, 255);
  if (transparent)
    for (let offset = 0; offset < pixels.length; offset += 4)
      pixels[offset + 3] = 0;
  const pixel = (x: number, y: number, rgba: number[]) =>
    pixels.set(rgba, (y * width + x) * 4);
  for (let y = 12; y < 28; y++) {
    for (let x = 10; x < 26; x++) pixel(x, y, [0, 0, 0, 255]);
    for (let x = 45; x < 61; x++) pixel(x, y, [0, 64, 192, 255]);
    for (const x of [9, 26])
      pixel(x, y, transparent ? [0, 0, 0, 128] : [128, 128, 128, 255]);
    for (const x of [44, 61])
      pixel(x, y, transparent ? [0, 64, 192, 128] : [128, 160, 224, 255]);
  }
  return sharp(pixels, { raw: { width, height, channels: 4 } })
    .png()
    .toBuffer();
}
export async function coloredPdf() {
  const doc = await PDFDocument.create(),
    page = doc.addPage([600, 800]);
  page.drawRectangle({
    x: 0,
    y: 0,
    width: 600,
    height: 800,
    color: rgb(46 / 255, 97 / 255, 143 / 255),
  });
  page.drawText("Transparent signature QA fixture", {
    x: 35,
    y: 760,
    size: 14,
  });
  return Buffer.from(await doc.save());
}
export async function samplePdf(rotations = true, repetitions = 1) {
  const doc = await PDFDocument.create(),
    font = await doc.embedFont(StandardFonts.Helvetica);
  for (const rotation of Array.from({ length: repetitions }, () =>
    rotations ? [0, 90, 180, 270] : [0],
  ).flat()) {
    const page = doc.addPage(rotation % 180 ? [800, 600] : [600, 800]);
    page.drawText("PaperSign test agreement", {
      x: 70,
      y: 470,
      size: 22,
      font,
      color: rgb(0.1, 0.2, 0.15),
    });
    page.drawText("QA fixture only. This is not a real contract.", {
      x: 70,
      y: 430,
      size: 12,
      font,
    });
    page.drawText("Name: ____________________", {
      x: 70,
      y: 350,
      size: 12,
      font,
    });
    page.drawText("Signature: _________________", {
      x: 70,
      y: 200,
      size: 12,
      font,
    });
    if (rotation === 180) page.setCropBox(30, 40, 500, 700);
    if (rotation === 270) page.setCropBox(20, 30, 740, 540);
    page.setRotation(degrees(rotation));
  }
  return Buffer.from(await doc.save());
}
