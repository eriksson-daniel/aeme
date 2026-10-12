import { lt } from "drizzle-orm";

import { createDb } from "../db/db.ts";
import { otpLoginsTable, sessionsTable } from "../db/schema.ts";

export const cleanupExpired = async (env: Env) => {
  const db = createDb(env);
  const now = new Date().toISOString();

  const [expiredOtps, expiredSessions] = await Promise.all([
    db
      .delete(otpLoginsTable)
      .where(lt(otpLoginsTable.expires, now))
      .returning({ otpHash: otpLoginsTable.otpHash }),
    db
      .delete(sessionsTable)
      .where(lt(sessionsTable.expires, now))
      .returning({ id: sessionsTable.id }),
  ]);

  console.log(
    `cleanup: removed ${expiredOtps.length} expired otp(s), ${expiredSessions.length} expired session(s)`,
  );
};
