export const MAX_SIGNATURE_PIXELS = 12_000_000;
export const MAX_SIGNATURE_BYTES = 2_000_000;
export const SIGNATURE_VISIBLE_ALPHA = 16;

/**
 * Remove a white matte in place, keeping the same appearance over white.
 * Common white becomes transparency, including gray antialiased stroke edges.
 * At least one resulting color channel is zero, making repeated cleanup stable.
 */
export function removeWhiteBackground(
  pixels: Uint8Array | Uint8ClampedArray,
): boolean {
  let visibleInk = false;
  for (let offset = 0; offset < pixels.length; offset += 4) {
    const alpha = pixels[offset + 3];
    if (alpha === 0) continue;
    const white = Math.min(
      pixels[offset],
      pixels[offset + 1],
      pixels[offset + 2],
    );
    if (white >= 245) {
      pixels[offset] =
        pixels[offset + 1] =
        pixels[offset + 2] =
        pixels[offset + 3] =
          0;
      continue;
    }
    if (white > 0) {
      const ink = 255 - white;
      pixels[offset] = Math.round(((pixels[offset] - white) * 255) / ink);
      pixels[offset + 1] = Math.round(
        ((pixels[offset + 1] - white) * 255) / ink,
      );
      pixels[offset + 2] = Math.round(
        ((pixels[offset + 2] - white) * 255) / ink,
      );
      pixels[offset + 3] = Math.round((alpha * ink) / 255);
    }
    if (pixels[offset + 3] > SIGNATURE_VISIBLE_ALPHA) visibleInk = true;
  }
  return visibleInk;
}
