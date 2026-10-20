import { eq } from "drizzle-orm";
import type { Context } from "hono";
import { setCookie } from "hono/cookie";

import { createDb } from "../db/db.ts";
import { channelsTable, sessionsTable, usersTable } from "../db/schema.ts";

export const SESSION_COOKIE_NAME = "session_id";
const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000;

export async function createSession(env: Env, params: { userId: string; channelId: string }) {
  const db = createDb(env);

  const [session] = await db
    .insert(sessionsTable)
    .values({
      id: crypto.randomUUID(),
      userId: params.userId,
      channelId: params.channelId,
      created: new Date().toISOString(),
      expires: new Date(Date.now() + SESSION_TTL_MS).toISOString(),
    })
    .returning();

  return session;
}

export function setSessionCookie(c: Context, session: { id: string; expires: string }) {
  setCookie(c, SESSION_COOKIE_NAME, session.id, {
    httpOnly: true,
    secure: true,
    sameSite: "Lax",
    path: "/",
    expires: new Date(session.expires),
  });
}

export type SessionMeta = {
  userId: string;
  userName: string;
  userColor: string;
  channelId: string;
  channelName: string;
  expires: string;
};

export async function getSessionMeta(env: Env, sessionId: string): Promise<SessionMeta | null> {
  const db = createDb(env);

  const [session] = await db
    .select({
      userId: sessionsTable.userId,
      userName: usersTable.name,
      userColor: usersTable.color,
      channelId: sessionsTable.channelId,
      channelName: channelsTable.name,
      expires: sessionsTable.expires,
    })
    .from(sessionsTable)
    .innerJoin(channelsTable, eq(sessionsTable.channelId, channelsTable.channelId))
    .innerJoin(usersTable, eq(sessionsTable.userId, usersTable.userId))
    .where(eq(sessionsTable.id, sessionId));

  if (!session) return null;
  if (session.expires < new Date().toISOString()) return null;

  return session;
}

export async function deleteSession(env: Env, sessionId: string): Promise<void> {
  const db = createDb(env);
  await db.delete(sessionsTable).where(eq(sessionsTable.id, sessionId));
}

/** Points an existing session at a different channel — the caller must
 * verify the user is actually a member of `channelId` first (see
 * `listChannelsForUser`); this just performs the update. */
export async function switchSessionChannel(
  env: Env,
  sessionId: string,
  channelId: string,
): Promise<void> {
  const db = createDb(env);
  await db.update(sessionsTable).set({ channelId }).where(eq(sessionsTable.id, sessionId));
}
