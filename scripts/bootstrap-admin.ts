import { randomUUID } from "node:crypto";
import { eq, sql } from "drizzle-orm";
import { db, pool } from "../server/db.js";
import { adminEvents, user } from "../server/schema.js";

// Promotes the first Admin. Either form names one existing account exactly:
//   --email EXACT_EMAIL
//   --user-id EXACT_ID --email EXACT_EMAIL
const args = process.argv.slice(2);
const byEmail = args.length === 2 && args[0] === "--email" && Boolean(args[1]);
const byId =
  args.length === 4 &&
  args[0] === "--user-id" &&
  args[2] === "--email" &&
  Boolean(args[1]) &&
  Boolean(args[3]);
if (!byEmail && !byId) {
  console.error(
    "Usage: node dist-server/scripts/bootstrap-admin.js --email EXACT_EMAIL\n" +
      "   or: node dist-server/scripts/bootstrap-admin.js --user-id EXACT_ID --email EXACT_EMAIL",
  );
  process.exitCode = 1;
} else {
  const email = byEmail ? args[1] : args[3];
  const userId = byId ? args[1] : undefined;
  try {
    const result = await db.transaction(async (tx) => {
      await tx.execute(sql`select pg_advisory_xact_lock(142, 41001)`);
      const [count] = await tx
        .select({ total: sql<number>`count(*)::int` })
        .from(user)
        .where(eq(user.role, "admin"));
      if (count.total !== 0)
        throw new Error(
          "Bootstrap refused: an Admin already exists. Use the Admin section.",
        );
      const target = await tx.query.user.findFirst({
        where: userId ? eq(user.id, userId) : eq(user.email, email),
      });
      if (!target || target.email !== email || target.role !== "user")
        throw new Error(
          userId
            ? "Bootstrap refused: the exact User ID, email and current User role must match."
            : "Bootstrap refused: no User account has exactly this email. Register first, then try again.",
        );
      await tx
        .update(user)
        .set({ role: "admin", updatedAt: new Date() })
        .where(eq(user.id, target.id));
      await tx.insert(adminEvents).values({
        id: randomUUID(),
        actorId: target.id,
        event: "first_admin_bootstrapped",
        targetType: "user",
        targetId: target.id,
        details: {
          previousRole: "user",
          role: "admin",
          method: "operator_cli",
        },
      });
      return { id: target.id, email: target.email, role: "admin" };
    });
    console.log(JSON.stringify(result));
  } catch (error) {
    console.error((error as Error).message);
    process.exitCode = 1;
  }
}
await pool.end();
