import { stat, statfs } from "node:fs/promises";
import { sql } from "drizzle-orm";
import { db } from "./db.js";
import { config } from "./config.js";
import { serviceHeartbeats } from "./schema.js";

export async function workerHeartbeat() {
  await db
    .insert(serviceHeartbeats)
    .values({ name: "pdf-worker", updatedAt: new Date() })
    .onConflictDoUpdate({
      target: serviceHeartbeats.name,
      set: { updatedAt: new Date() },
    });
}
export interface OperationalCheck {
  name: string;
  ok: boolean;
  detail: string;
}
export async function operationalChecks(
  includeBackup = false,
): Promise<OperationalCheck[]> {
  const checks: OperationalCheck[] = [];
  try {
    const result = await db.execute<{
      heartbeat: Date | null;
      oldest: Date | null;
      failed: number;
    }>(sql`
      select (select updated_at from service_heartbeat where name = 'pdf-worker') as heartbeat,
      (select min(created_at) from document_export where state in ('queued','working')) as oldest,
      (select count(*)::int from document_export where state = 'failed' and created_at > now() - interval '1 hour') as failed
    `);
    const state = result.rows[0];
    checks.push({ name: "database", ok: true, detail: "Connected" });
    checks.push({
      name: "worker",
      ok:
        !!state.heartbeat &&
        Date.now() - new Date(state.heartbeat).getTime() < 120_000,
      detail: state.heartbeat
        ? new Date(state.heartbeat).toISOString()
        : "No worker heartbeat",
    });
    checks.push({
      name: "queue",
      ok:
        !state.oldest ||
        Date.now() - new Date(state.oldest).getTime() < 900_000,
      detail: state.oldest
        ? `Oldest active export: ${new Date(state.oldest).toISOString()}`
        : "No waiting exports",
    });
    checks.push({
      name: "exports",
      ok: state.failed === 0,
      detail: `${state.failed} failed exports in the last hour`,
    });
  } catch {
    checks.push({
      name: "database",
      ok: false,
      detail: "Database check failed",
    });
  }
  try {
    const space = await statfs(config.DATA_DIR),
      available = space.bavail * space.bsize;
    checks.push({
      name: "storage",
      ok: available >= 1024 ** 3,
      detail: `${Math.floor(available / 1024 ** 2)} MB available`,
    });
  } catch {
    checks.push({
      name: "storage",
      ok: false,
      detail: "Storage is unavailable",
    });
  }
  if (includeBackup) {
    try {
      const backup = await stat(config.BACKUP_FILE);
      checks.push({
        name: "backup",
        ok: backup.size > 0 && Date.now() - backup.mtimeMs < 3 * 3600_000,
        detail: `Database backup modified ${backup.mtime.toISOString()}`,
      });
    } catch {
      checks.push({
        name: "backup",
        ok: false,
        detail: "Database backup metadata unavailable",
      });
    }
  }
  return checks;
}
