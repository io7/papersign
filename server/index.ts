import { buildApp } from "./app.js";
import { config } from "./config.js";
import { pool } from "./db.js";
import { queue, startQueue } from "./queue.js";
await startQueue();
const app = await buildApp();
await app.listen({ port: config.PORT, host: config.HOST });
async function stop() {
  await app.close();
  await queue.stop();
  await pool.end();
  process.exit(0);
}
process.on("SIGTERM", stop);
process.on("SIGINT", stop);
