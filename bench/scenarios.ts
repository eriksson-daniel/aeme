import {
  getActivityById,
  listActivitiesForChannel,
  listPastBookingsForActivity,
} from "../src/worker/activities/activity.ts";
import { upsertAvailability, wouldExceedMax } from "../src/worker/activities/availability.ts";
import { getSessionMeta } from "../src/worker/auth/session.ts";
import { listChannelMembers, listChannelsForUser } from "../src/worker/channels/channel.ts";
import type { Fixture } from "./dataset.ts";

/** The worker's own functions are what we measure — not re-written queries —
 * so a number here is a number the app actually pays. Everything a scenario
 * touches must therefore avoid Slack: `announceActivitySuggestion` returns
 * after one read for a persistent activity and posts for a one-off, which is
 * why the write scenario only ever touches persistent ones. */
export type Scenario = {
  name: string;
  description: string;
  run: (env: Env, fixture: Fixture) => Promise<unknown>;
};

export const SCENARIOS: Scenario[] = [
  {
    name: "dashboard",
    description:
      "GET /api/activities end to end — the 10s poll every open tab makes: session lookup then the whole activity list.",
    run: async (env, fixture) => {
      const session = await getSessionMeta(env, fixture.sessionId);
      if (!session) throw new Error("fixture session missing");
      return listActivitiesForChannel(env, session.channelId, session.userId);
    },
  },
  {
    name: "activities",
    description: "listActivitiesForChannel on its own, without the session lookup in front of it.",
    run: (env, fixture) => listActivitiesForChannel(env, fixture.channelId, fixture.userId),
  },
  {
    name: "session",
    description: "getSessionMeta — the auth check in front of every single authenticated route.",
    run: (env, fixture) => getSessionMeta(env, fixture.sessionId),
  },
  {
    name: "history",
    description:
      "GET /api/activities/:id/bookings/history — a standing activity's whole past, loaded on demand.",
    run: async (env, fixture) => {
      await getSessionMeta(env, fixture.sessionId);
      await getActivityById(env, fixture.persistentActivityId);
      return listPastBookingsForActivity(env, fixture.persistentActivityId);
    },
  },
  {
    name: "members",
    description: "GET /api/channels/members — the attendee picker's roster.",
    run: async (env, fixture) => {
      await getSessionMeta(env, fixture.sessionId);
      return listChannelMembers(env, fixture.channelId);
    },
  },
  {
    name: "channels",
    description: "GET /api/session/channels — the channel switcher.",
    run: async (env, fixture) => {
      await getSessionMeta(env, fixture.sessionId);
      return listChannelsForUser(env, fixture.userId);
    },
  },
  {
    name: "respond",
    description:
      "PUT /api/activities/:id/availability — the headcount check and the upsert, as the route runs them.",
    run: async (env, fixture) => {
      const session = await getSessionMeta(env, fixture.sessionId);
      if (!session) throw new Error("fixture session missing");

      const activity = await getActivityById(env, fixture.cappedActivityId);
      if (!activity) throw new Error("fixture activity missing");
      // Guard rail, not a formality: `upsertAvailability` announces to Slack
      // for a one-off, so a fixture pointing at the wrong activity would turn
      // a benchmark into a few hundred real messages in a real channel.
      if (!activity.persistent) {
        throw new Error(`refusing to benchmark writes against one-off activity ${activity.id}`);
      }

      const slots = [{ date: new Date().toISOString().slice(0, 10), from: "17:00", to: "19:00" }];

      if (activity.maxMemberCount !== null) {
        await wouldExceedMax(env, {
          activityId: activity.id,
          userId: fixture.freshUserId,
          maxMemberCount: activity.maxMemberCount,
          slots,
          plusOne: false,
        });
      }

      return upsertAvailability(env, {
        activityId: activity.id,
        userId: fixture.freshUserId,
        slots,
        declined: false,
        plusOne: false,
      });
    },
  },
];

export const scenarioByName = (name: string): Scenario => {
  const scenario = SCENARIOS.find((candidate) => candidate.name === name);
  if (!scenario) {
    throw new Error(
      `unknown scenario "${name}" — try one of: ${SCENARIOS.map((s) => s.name).join(", ")}`,
    );
  }
  return scenario;
};
