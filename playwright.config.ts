import { defineConfig } from "@playwright/test";
export default defineConfig({
  testDir: "tests/browser",
  workers: 1,
  timeout: 90000,
  use: {
    baseURL: process.env.TEST_BASE_URL ?? "http://127.0.0.1:3176",
    viewport: { width: 1440, height: 1000 },
    extraHTTPHeaders:
      process.env.TEST_CLIENT_IP_PROBE === "true"
        ? {
            "X-Real-IP": "198.51.100.19",
            "X-Forwarded-For": "198.51.100.19",
            "X-PaperSign-Client-IP": "198.51.100.19",
          }
        : undefined,
    // Playwright's own Chromium unless CHROMIUM_PATH points at another build.
    launchOptions: process.env.CHROMIUM_PATH
      ? { executablePath: process.env.CHROMIUM_PATH }
      : {},
    video: "retain-on-failure",
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
  },
  reporter: [
    ["list"],
    ["json", { outputFile: ".local/qa/browser-results.json" }],
  ],
});
