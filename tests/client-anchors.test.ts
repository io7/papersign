import { describe, expect, it } from "vitest";
import { PDFDocument, StandardFonts, degrees } from "pdf-lib";
// @ts-expect-error The command-line client is plain JavaScript.
import {
  findAll,
  findAnchor,
  loadLayout,
  openPdf,
  closePdf,
  placeBox,
} from "../client/anchors.mjs";
// @ts-expect-error The command-line client is plain JavaScript.
import { planSpec } from "../client/plan.mjs";

type Crop = { x: number; y: number; width: number; height: number };
const PAGES: Array<{ rotation: number; size: [number, number]; crop?: Crop }> =
  [
    { rotation: 0, size: [600, 800] },
    { rotation: 90, size: [800, 600] },
    {
      rotation: 180,
      size: [600, 800],
      crop: { x: 30, y: 40, width: 500, height: 700 },
    },
    {
      rotation: 270,
      size: [800, 600],
      crop: { x: 20, y: 30, width: 740, height: 540 },
    },
  ];
const ORIGIN = { x: 70, y: 200 };
const SIZE = 12;

async function fixture() {
  const doc = await PDFDocument.create();
  const font = await doc.embedFont(StandardFonts.Helvetica);
  for (const spec of PAGES) {
    const page = doc.addPage(spec.size);
    page.drawText("Signature:", { ...ORIGIN, size: SIZE, font });
    page.drawText("Ada Example, Chair", { x: 70, y: 330, size: 11, font });
    page.drawText("Place and date:", { x: 70, y: 312, size: 11, font });
    page.drawText("Bo Example, Member", { x: 330, y: 330, size: 11, font });
    page.drawText("Place and date:", { x: 330, y: 312, size: 11, font });
    if (spec.crop)
      page.setCropBox(
        spec.crop.x,
        spec.crop.y,
        spec.crop.width,
        spec.crop.height,
      );
    page.setRotation(degrees(spec.rotation));
  }
  return {
    bytes: Buffer.from(await doc.save()),
    width: font.widthOfTextAtSize("Signature:", SIZE),
  };
}

// The exact mapping server/pdf-process.ts uses to stamp a field, inverted
// to user space, so the client is checked against the server's convention.
function fieldToUser(
  field: { x: number; y: number; width: number; height: number },
  page: (typeof PAGES)[number],
) {
  const box = page.crop ?? {
    x: 0,
    y: 0,
    width: page.size[0],
    height: page.size[1],
  };
  const W = page.rotation % 180 ? box.height : box.width,
    H = page.rotation % 180 ? box.width : box.height;
  const m =
    page.rotation === 90
      ? [0, 1, -1, 0, box.x + box.width, box.y]
      : page.rotation === 180
        ? [-1, 0, 0, -1, box.x + box.width, box.y + box.height]
        : page.rotation === 270
          ? [0, -1, 1, 0, box.x, box.y + box.height]
          : [1, 0, 0, 1, box.x, box.y];
  const corners = [
    [field.x * W, (1 - field.y - field.height) * H],
    [(field.x + field.width) * W, (1 - field.y) * H],
  ].map(([X, Y]) => [m[0] * X + m[2] * Y + m[4], m[1] * X + m[3] * Y + m[5]]);
  return {
    left: Math.min(corners[0][0], corners[1][0]),
    right: Math.max(corners[0][0], corners[1][0]),
    bottom: Math.min(corners[0][1], corners[1][1]),
    top: Math.max(corners[0][1], corners[1][1]),
  };
}

describe("client anchor placement", () => {
  it("lands a box on the anchor text exactly where the server will stamp it, on every rotation", async () => {
    const { bytes, width } = await fixture();
    const pdf = await openPdf(bytes);
    try {
      const layout = await loadLayout(pdf);
      expect(layout).toHaveLength(PAGES.length);
      PAGES.forEach((page, pageIndex) => {
        const [match] = findAll(layout, "signature:", pageIndex + 1);
        expect(match.text).toBe("Signature:");
        const a = match.box;
        const placed = placeBox(
          match,
          layout[pageIndex],
          { position: "over" },
          {
            width: a.right - a.left,
            height: () => a.bottom - a.top,
            position: "over",
          },
        );
        const user = fieldToUser(placed.field, page);
        const label = `rotation ${page.rotation}`;
        expect(user.left, label).toBeCloseTo(ORIGIN.x, 0);
        expect(user.right, label).toBeCloseTo(ORIGIN.x + width, 0);
        expect(user.bottom, label).toBeCloseTo(ORIGIN.y, 0);
        expect(user.top, label).toBeCloseTo(ORIGIN.y + SIZE, 0);
      });
    } finally {
      await closePdf(pdf);
    }
  });

  it("chooses repeated labels by proximity, by occurrence, and explains misses", async () => {
    const { bytes } = await fixture();
    const pdf = await openPdf(bytes);
    try {
      const layout = await loadLayout(pdf);
      const near = (name: string) =>
        findAnchor(layout, { anchor: "Place and date:", near: name, page: 1 });
      const ada = near("Ada Example, Chair"),
        bo = near("Bo Example, Member");
      expect(ada.count).toBe(2);
      expect(ada.match.box.left).toBeCloseTo(70, 0);
      expect(bo.match.box.left).toBeCloseTo(330, 0);
      expect(
        findAnchor(layout, {
          anchor: "place  AND date:",
          occurrence: 2,
          page: 1,
        }).match.box.left,
      ).toBeCloseTo(330, 0);
      expect(() =>
        findAnchor(layout, { anchor: "Nowhere to be found" }),
      ).toThrow(/Could not find/);
      expect(() =>
        findAnchor(layout, {
          anchor: "Place and date:",
          occurrence: 9,
          page: 1,
        }),
      ).toThrow(/appears 2 time/);
    } finally {
      await closePdf(pdf);
    }
  });

  it("plans signers and text into the shape the invitations API accepts", async () => {
    const { bytes } = await fixture();
    const plan = await planSpec(
      {
        signers: [
          {
            name: "Ada Example",
            email: "ada@example.test",
            signature: { anchor: "Ada Example, Chair", page: 1 },
            text: [
              {
                label: "Place and date",
                anchor: "Place and date:",
                near: "Ada Example, Chair",
                page: 1,
              },
            ],
          },
        ],
        ownerText: [{ text: "London", anchor: "Signature:", page: 1 }],
      },
      bytes,
    );
    const [ada] = plan.recipients;
    expect(ada.field).toMatchObject({ pageIndex: 0 });
    expect(ada.field.id).toMatch(/^[0-9a-f-]{36}$/);
    // Signature sits above the name: its bottom edge is above the name's top.
    const name = (330 + 11) / 800;
    expect(ada.field.y + ada.field.height).toBeLessThan(1 - name + 0.01);
    expect(ada.textFields[0]).toMatchObject({
      label: "Place and date",
      fontSize: 10,
    });
    expect(ada.textFields[0].x).toBeGreaterThan(70 / 600);
    expect(plan.ownerText[0]).toMatchObject({ kind: "text", text: "London" });
    for (const box of [ada.field, ada.textFields[0], plan.ownerText[0]]) {
      expect(box.x + box.width).toBeLessThanOrEqual(1);
      expect(box.y + box.height).toBeLessThanOrEqual(1);
    }
    await expect(
      planSpec(
        {
          signers: [
            {
              name: "A",
              email: "a@example.test",
              signature: { anchor: "Signature:" },
            },
            {
              name: "B",
              email: "A@example.test",
              signature: { anchor: "Signature:" },
            },
          ],
        },
        bytes,
      ),
    ).rejects.toThrow(/appears twice/);
  });
});
