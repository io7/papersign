import { spawn } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { config } from "./config.js";
import { filePath } from "./storage.js";
import type { PageInfo, FrozenPlacement } from "../shared/types.js";
async function run(command: string, args: string[], timeout: number) {
  return new Promise<void>((resolvePromise, reject) => {
    const child = spawn(command, args, {
      stdio: ["ignore", "ignore", "pipe"],
      env: {
        PATH: process.env.PATH,
        NODE_ENV: "production",
        NODE_OPTIONS: "",
      },
    });
    let errorText = "",
      timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGKILL");
    }, timeout);
    child.stderr.on("data", (chunk) => {
      if (errorText.length < 4000) errorText += chunk;
    });
    child.on("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      if (code === 0) resolvePromise();
      else
        reject(
          new Error(
            timedOut
              ? "PDF processing took too long. Try a smaller document."
              : errorText.includes("encrypted")
                ? "Password-protected PDFs are not supported. Upload an unlocked copy."
                : "This PDF could not be processed. Try exporting a fresh PDF from the original application.",
          ),
        );
    });
  });
}
export async function processPdf(
  operation: "inspect" | "stamp",
  inputKey: string,
  layers: FrozenPlacement[] = [],
) {
  const temp = await mkdtemp(join(tmpdir(), "papersign-"));
  try {
    const output = join(
      temp,
      operation === "inspect" ? "info.json" : "signed.pdf",
    );
    const layerFile = join(temp, "layers.json");
    await writeFile(layerFile, JSON.stringify(layers), { mode: 0o600 });
    const isTs = import.meta.url.endsWith(".ts");
    const script = fileURLToPath(
      new URL(isTs ? "./pdf-process.ts" : "./pdf-process.js", import.meta.url),
    );
    await run(
      process.execPath,
      [
        "--max-old-space-size=384",
        ...(isTs ? ["--import", "tsx"] : []),
        script,
        operation,
        filePath(inputKey),
        output,
        layerFile,
        config.DATA_DIR,
      ],
      45000,
    );
    return await readFile(output);
  } finally {
    await rm(temp, { recursive: true, force: true });
  }
}
export async function inspectPdf(key: string) {
  return JSON.parse(
    (await processPdf("inspect", key)).toString(),
  ) as PageInfo[];
}
export async function renderPdf(
  key: string,
  layers: FrozenPlacement[],
  rasterize: boolean,
) {
  const stamped = await processPdf("stamp", key, layers);
  if (!rasterize) return stamped;
  const temp = await mkdtemp(join(tmpdir(), "papersign-raster-"));
  try {
    const input = join(temp, "input.pdf"),
      output = join(temp, "output.pdf");
    await writeFile(input, stamped, { mode: 0o600 });
    const isTs = import.meta.url.endsWith(".ts");
    const script = fileURLToPath(
      new URL(
        isTs ? "./pdf-rasterize.ts" : "./pdf-rasterize.js",
        import.meta.url,
      ),
    );
    await run(
      process.execPath,
      [
        "--max-old-space-size=512",
        ...(isTs ? ["--import", "tsx"] : []),
        script,
        input,
        output,
      ],
      180000,
    );
    return await readFile(output);
  } finally {
    await rm(temp, { recursive: true, force: true });
  }
}
