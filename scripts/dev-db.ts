import EmbeddedPostgres from "embedded-postgres";
import { existsSync } from "node:fs";
try {
  process.loadEnvFile();
} catch {
  /* .env is required below */
}
const url = new URL(process.env.DATABASE_URL!);
if (url.hostname !== "127.0.0.1" || url.port !== "54376")
  throw new Error(
    "dev:db only manages the isolated local database on 127.0.0.1:54376.",
  );
const pg = new EmbeddedPostgres({
  databaseDir: ".local/postgres",
  user: url.username,
  password: decodeURIComponent(url.password),
  port: 54376,
  persistent: true,
  authMethod: "scram-sha-256",
  postgresFlags: ["-h", "127.0.0.1"],
  onLog: () => {},
  onError: (msg) => console.error(String(msg)),
});
if (!existsSync(".local/postgres/PG_VERSION")) await pg.initialise();
await pg.start();
const client = pg.getPgClient();
await client.connect();
const exists = await client.query(
  "SELECT 1 FROM pg_database WHERE datname = $1",
  ["papersign"],
);
await client.end();
if (!exists.rowCount) await pg.createDatabase("papersign");
console.log("Isolated PaperSign PostgreSQL ready on 127.0.0.1:54376.");
async function stop() {
  await pg.stop();
  process.exit(0);
}
process.on("SIGINT", stop);
process.on("SIGTERM", stop);
await new Promise(() => {});
