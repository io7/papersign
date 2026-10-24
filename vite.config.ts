import { defineConfig } from "vite";
import vue from "@vitejs/plugin-vue";
import { cpSync, mkdirSync } from "node:fs";
for (const asset of ["cmaps", "standard_fonts", "wasm"]) {
  mkdirSync("public/pdfjs", { recursive: true });
  cpSync(`node_modules/pdfjs-dist/${asset}`, `public/pdfjs/${asset}`, {
    recursive: true,
  });
}
export default defineConfig({
  plugins: [vue()],
  server: {
    port: 5176,
    strictPort: true,
    proxy: { "/api": "http://127.0.0.1:3176" },
  },
  build: {
    outDir: "dist",
    chunkSizeWarningLimit: 1100,
    rolldownOptions: {
      output: {
        // PDF.js (rendering) and pdf-lib (text measuring) are most of the
        // download; only the editor and signing pages load these named chunks.
        codeSplitting: {
          groups: [
            { name: "pdfjs", test: /node_modules[\\/]pdfjs-dist/ },
            { name: "pdf-lib", test: /node_modules[\\/]pdf-lib/ },
          ],
        },
      },
    },
  },
});
