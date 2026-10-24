import { defineConfig } from "drizzle-kit";
try {
  process.loadEnvFile();
} catch {
  /* CI can supply env */
}
export default defineConfig({
  dialect: "postgresql",
  schema: "./server/schema.ts",
  out: "./drizzle",
  dbCredentials: { url: process.env.DATABASE_URL ?? "" },
});
