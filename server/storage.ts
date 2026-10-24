import {
  mkdir,
  readFile,
  writeFile,
  rename,
  rm,
  statfs,
} from "node:fs/promises";
import {
  randomUUID,
  createHash,
  createCipheriv,
  createDecipheriv,
  randomBytes,
} from "node:crypto";
import { join } from "node:path";
import sharp from "sharp";
import { config } from "./config.js";
import {
  MAX_SIGNATURE_BYTES,
  MAX_SIGNATURE_PIXELS,
  SIGNATURE_VISIBLE_ALPHA,
  removeWhiteBackground,
} from "../shared/signature-image.js";
export const sha256 = (bytes: Buffer | string) =>
  createHash("sha256").update(bytes).digest("hex");
export function filePath(key: string) {
  if (!/^[a-f0-9-]{36}\.(png|pdf|json)$/.test(key))
    throw new Error("Invalid storage key");
  return join(config.DATA_DIR, key);
}
export async function storeFile(
  bytes: Buffer,
  extension: "png" | "pdf" | "json",
) {
  await mkdir(config.DATA_DIR, { recursive: true, mode: 0o700 });
  const space = await statfs(config.DATA_DIR);
  if (space.bavail * space.bsize < bytes.length + 512 * 1024 * 1024)
    throw Object.assign(
      new Error(
        "Storage is nearly full. Please contact the PaperSign operator.",
      ),
      { statusCode: 503, publicError: true },
    );
  const key = `${randomUUID()}.${extension}`;
  const tmp = `${filePath(key)}.tmp`;
  await writeFile(tmp, bytes, { mode: 0o600, flag: "wx" });
  await rename(tmp, filePath(key));
  return key;
}
export const loadFile = (key: string) => readFile(filePath(key));
export const removeFile = (key: string) => rm(filePath(key), { force: true });
export async function normalizeSignature(data: string) {
  if (
    !/^data:image\/png;base64,[A-Za-z0-9+/=]+$/.test(data) ||
    data.length > 3_000_000
  )
    throw Object.assign(new Error("Choose a PNG smaller than 2 MB."), {
      statusCode: 400,
    });
  const bytes = Buffer.from(data.slice(data.indexOf(",") + 1), "base64");
  if (bytes.length > MAX_SIGNATURE_BYTES)
    throw Object.assign(new Error("Choose a PNG smaller than 2 MB."), {
      statusCode: 400,
    });
  const metadata = await sharp(bytes, {
    limitInputPixels: MAX_SIGNATURE_PIXELS,
  }).metadata();
  if (metadata.format !== "png" || !metadata.width || !metadata.height)
    throw Object.assign(new Error("This file is not a valid PNG."), {
      statusCode: 400,
    });
  const { data: pixels, info } = await sharp(bytes, {
    limitInputPixels: MAX_SIGNATURE_PIXELS,
  })
    .toColourspace("srgb")
    .ensureAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true });
  removeWhiteBackground(pixels);
  let left = info.width,
    top = info.height,
    right = -1,
    bottom = -1;
  for (let y = 0; y < info.height; y++)
    for (let x = 0; x < info.width; x++) {
      const offset = (y * info.width + x) * 4;
      if (pixels[offset + 3] > SIGNATURE_VISIBLE_ALPHA) {
        left = Math.min(left, x);
        right = Math.max(right, x);
        top = Math.min(top, y);
        bottom = Math.max(bottom, y);
      }
    }
  if (right < left || bottom < top)
    throw Object.assign(
      new Error("The signature is blank. Draw or upload a visible signature."),
      { statusCode: 400 },
    );
  const margin = 8;
  const clipped = await sharp(pixels, {
    raw: { width: info.width, height: info.height, channels: 4 },
    limitInputPixels: MAX_SIGNATURE_PIXELS,
  })
    .extract({ left, top, width: right - left + 1, height: bottom - top + 1 })
    .resize({
      width: 1600,
      height: 600,
      fit: "inside",
      withoutEnlargement: true,
    })
    .extend({
      top: margin,
      bottom: margin,
      left: margin,
      right: margin,
      background: { r: 0, g: 0, b: 0, alpha: 0 },
    })
    .png()
    .toBuffer({ resolveWithObject: true });
  return {
    bytes: clipped.data,
    width: clipped.info.width,
    height: clipped.info.height,
  };
}
const encryptionKey = createHash("sha256")
  .update(config.BETTER_AUTH_SECRET)
  .update("papersign-invitation-v1")
  .digest();
export function seal(value: string) {
  const iv = randomBytes(12),
    cipher = createCipheriv("aes-256-gcm", encryptionKey, iv);
  return Buffer.concat([
    iv,
    cipher.update(value),
    cipher.final(),
    cipher.getAuthTag(),
  ]).toString("base64url");
}
export function unseal(value: string) {
  const bytes = Buffer.from(value, "base64url");
  const cipher = createDecipheriv(
    "aes-256-gcm",
    encryptionKey,
    bytes.subarray(0, 12),
  );
  cipher.setAuthTag(bytes.subarray(-16));
  return Buffer.concat([
    cipher.update(bytes.subarray(12, -16)),
    cipher.final(),
  ]).toString();
}
