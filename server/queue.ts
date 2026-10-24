import { PgBoss } from "pg-boss";
import { config } from "./config.js";
export const queue = new PgBoss({ connectionString: config.DATABASE_URL });
export async function startQueue() {
  queue.on("error", (err) => console.error("Queue error:", err.message));
  await queue.start();
  await queue.createQueue("pdf-export", {
    retryLimit: 1,
    retryDelay: 10,
    expireInSeconds: 600,
  });
  await queue.updateQueue("pdf-export", { expireInSeconds: 600 });
}
