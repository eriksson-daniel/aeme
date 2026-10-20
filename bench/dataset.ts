import { createClient, type Client, type InStatement } from "@libsql/client";

import { USER_COLOR_PALETTE } from "../src/worker/users/colors.ts";

/** Every row this harness writes carries this prefix in its primary key, so
 * cleanup can be exact rather than a `delete from`. Nothing the real app
 * creates can collide with it: ids elsewhere are UUIDs or Slack ids. */
export const BENCH_PREFIX = "bench-";

export type Scale = "small" | "medium" | "large";

export type ScaleSpec = {
  channels: number;
  usersPerChannel: number;
  /** Standing activities — the ones that accumulate bookings forever. */
  persistentPerChannel: number;
  /** One-off suggestions, which carry all of their bookings in the dashboard
   * payload rather than only the future ones. */
  oneOffPerChannel: number;
  /** How many of a channel's users answer each activity. */
  respondersPerActivity: number;
  /** Days each responder picks. */
  slotsPerResponse: number;
  locationsPerPersistent: number;
  pastBookingsPerPersistent: number;
  futureBookingsPerPersistent: number;
  bookingsPerOneOff: number;
  attendeesPerBooking: number;
};

/** `small` is roughly today's shape, `medium` a busy channel a year in, and
 * `large` a deliberately pessimistic ceiling — a workspace far bigger than
 * æme is built for, so a plan that holds there holds anywhere. */
export const SCALES: Record<Scale, ScaleSpec> = {
  small: {
    channels: 1,
    usersPerChannel: 12,
    persistentPerChannel: 3,
    oneOffPerChannel: 4,
    respondersPerActivity: 8,
    slotsPerResponse: 4,
    locationsPerPersistent: 2,
    pastBookingsPerPersistent: 20,
    futureBookingsPerPersistent: 2,
    bookingsPerOneOff: 1,
    attendeesPerBooking: 5,
  },
  medium: {
    channels: 3,
    usersPerChannel: 60,
    persistentPerChannel: 8,
    oneOffPerChannel: 20,
    respondersPerActivity: 35,
    slotsPerResponse: 8,
    locationsPerPersistent: 4,
    pastBookingsPerPersistent: 120,
    futureBookingsPerPersistent: 4,
    bookingsPerOneOff: 2,
    attendeesPerBooking: 12,
  },
  large: {
    channels: 6,
    usersPerChannel: 250,
    persistentPerChannel: 20,
    oneOffPerChannel: 60,
    respondersPerActivity: 150,
    slotsPerResponse: 14,
    locationsPerPersistent: 8,
    pastBookingsPerPersistent: 500,
    futureBookingsPerPersistent: 8,
    bookingsPerOneOff: 3,
    attendeesPerBooking: 25,
  },
};

/** The handles a scenario needs to drive the seeded data: one session to read
 * as, and ids to ask about. */
export type Fixture = {
  scale: Scale;
  sessionId: string;
  userId: string;
  channelId: string;
  /** A standing activity with a long booking history — the history endpoint's
   * worst case. */
  persistentActivityId: string;
  /** A standing activity with a `maxMemberCount`, so the headcount check in
   * `wouldExceedMax` actually runs. */
  cappedActivityId: string;
  /** A user who has *not* answered `cappedActivityId`, so the availability
   * write is an insert rather than a no-op update. */
  freshUserId: string;
};

const pad = (n: number, width = 4) => String(n).padStart(width, "0");

const isoDaysFromNow = (days: number) => {
  const date = new Date();
  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString();
};

const dateDaysFromNow = (days: number) => isoDaysFromNow(days).slice(0, 10);

/** libsql caps how much one pipeline may carry, and a single 100k-row insert
 * is also just slower to build than a few batches of it. */
const BATCH_SIZE = 500;

const runBatched = async (client: Client, statements: InStatement[]) => {
  for (let i = 0; i < statements.length; i += BATCH_SIZE) {
    await client.batch(statements.slice(i, i + BATCH_SIZE), "write");
  }
};

/** Deletes only what this harness created, child rows first — `PRAGMA
 * foreign_keys` is off by default in SQLite, so the schema's `ON DELETE
 * CASCADE` can't be relied on to do it for us. */
export const clean = async (client: Client) => {
  const like = `${BENCH_PREFIX}%`;
  const deletes: [string, string][] = [
    ["activity_booking_attendees", "id"],
    ["activity_bookings", "id"],
    ["activity_availability", "id"],
    ["activity_locations", "id"],
    ["activities", "id"],
    ["channel_members", "id"],
    ["sessions", "id"],
    ["otp_logins", "otp_hash"],
    ["channels", "channel_id"],
    ["users", "user_id"],
  ];

  for (const [table, column] of deletes) {
    await client.execute({ sql: `delete from ${table} where ${column} like ?`, args: [like] });
  }
};

export const seed = async (client: Client, scale: Scale): Promise<Fixture> => {
  const spec = SCALES[scale];
  await clean(client);

  const now = new Date().toISOString();
  const users: InStatement[] = [];
  const channels: InStatement[] = [];
  const members: InStatement[] = [];
  const sessions: InStatement[] = [];
  const activities: InStatement[] = [];
  const availability: InStatement[] = [];
  const locations: InStatement[] = [];
  const bookings: InStatement[] = [];
  const attendees: InStatement[] = [];

  const totalUsers = spec.channels * spec.usersPerChannel;
  for (let u = 0; u < totalUsers; u++) {
    users.push({
      sql: "insert into users (user_id, name, color, created) values (?, ?, ?, ?)",
      args: [
        `${BENCH_PREFIX}U${pad(u, 5)}`,
        `Bench User ${u}`,
        USER_COLOR_PALETTE[u % USER_COLOR_PALETTE.length],
        now,
      ],
    });
  }

  let fixture: Fixture | null = null;

  for (let c = 0; c < spec.channels; c++) {
    const channelId = `${BENCH_PREFIX}C${pad(c, 3)}`;
    // Users are dealt out per channel rather than shared, so a channel's
    // member list is the size the scale says it is.
    const channelUsers = Array.from(
      { length: spec.usersPerChannel },
      (_, i) => `${BENCH_PREFIX}U${pad(c * spec.usersPerChannel + i, 5)}`,
    );
    const owner = channelUsers[0];

    channels.push({
      sql: "insert into channels (channel_id, name, owner, created) values (?, ?, ?, ?)",
      args: [channelId, `bench-channel-${c}`, owner, now],
    });

    channelUsers.forEach((userId, i) => {
      members.push({
        sql: "insert into channel_members (id, channel_id, user_id, joined) values (?, ?, ?, ?)",
        args: [`${BENCH_PREFIX}M${pad(c, 3)}-${pad(i, 5)}`, channelId, userId, now],
      });
    });

    sessions.push({
      sql: "insert into sessions (id, user_id, channel_id, created, expires) values (?, ?, ?, ?, ?)",
      args: [`${BENCH_PREFIX}S${pad(c, 3)}`, owner, channelId, now, isoDaysFromNow(30)],
    });

    const persistentIds: string[] = [];
    const activityIds: string[] = [];

    for (let a = 0; a < spec.persistentPerChannel + spec.oneOffPerChannel; a++) {
      const persistent = a < spec.persistentPerChannel;
      const activityId = `${BENCH_PREFIX}A${pad(c, 3)}-${pad(a, 4)}`;
      activityIds.push(activityId);
      if (persistent) persistentIds.push(activityId);

      // Every third standing activity is capped, so `wouldExceedMax` has
      // something to chew on. The cap is generous enough that seeded
      // responses don't trip it.
      const maxMemberCount = persistent && a % 3 === 0 ? spec.respondersPerActivity * 4 : null;

      activities.push({
        sql:
          "insert into activities (id, channel_id, created_by, title, description, end_time, persistent, slot_granularity, suggested_dates, ideal_member_count, max_member_count, slack_message_ts, archived, created) " +
          "values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
        args: [
          activityId,
          channelId,
          channelUsers[a % channelUsers.length],
          `Bench activity ${a}`,
          "Seeded by the load-test harness.",
          persistent ? null : isoDaysFromNow(7),
          persistent ? 1 : 0,
          a % 2 === 0 ? "hourly" : "day",
          persistent
            ? null
            : JSON.stringify(
                Array.from({ length: spec.slotsPerResponse }, (_, d) => dateDaysFromNow(d + 1)),
              ),
          spec.respondersPerActivity,
          maxMemberCount,
          // Non-null for one-offs: the real ones have been announced, and a
          // null here would make the dashboard's shape unrepresentative.
          persistent ? null : `17000000.${pad(a, 6)}`,
          0,
          now,
        ],
      });

      for (let r = 0; r < Math.min(spec.respondersPerActivity, channelUsers.length); r++) {
        const hourly = a % 2 === 0;
        const slots = Array.from({ length: spec.slotsPerResponse }, (_, d) =>
          hourly
            ? { date: dateDaysFromNow(d + 1), from: "17:00", to: "20:00" }
            : { date: dateDaysFromNow(d + 1) },
        );

        availability.push({
          sql:
            "insert into activity_availability (id, activity_id, user_id, slots, declined, plus_one, created, updated) " +
            "values (?, ?, ?, ?, ?, ?, ?, ?)",
          args: [
            `${BENCH_PREFIX}AV${pad(c, 3)}-${pad(a, 4)}-${pad(r, 5)}`,
            activityId,
            channelUsers[r],
            JSON.stringify(slots),
            0,
            r % 5 === 0 ? 1 : 0,
            now,
            now,
          ],
        });
      }

      const locationIds: string[] = [];
      if (persistent) {
        for (let l = 0; l < spec.locationsPerPersistent; l++) {
          const locationId = `${BENCH_PREFIX}L${pad(c, 3)}-${pad(a, 4)}-${pad(l, 3)}`;
          locationIds.push(locationId);
          locations.push({
            sql: "insert into activity_locations (id, activity_id, name, maps_url, archived, created) values (?, ?, ?, ?, ?, ?)",
            args: [
              locationId,
              activityId,
              `Place ${l}`,
              `https://maps.example.com/${locationId}`,
              0,
              now,
            ],
          });
        }
      }

      const bookingOffsets = persistent
        ? [
            ...Array.from({ length: spec.pastBookingsPerPersistent }, (_, i) => -(i + 1) * 7),
            ...Array.from({ length: spec.futureBookingsPerPersistent }, (_, i) => (i + 1) * 7),
          ]
        : Array.from({ length: spec.bookingsPerOneOff }, (_, i) => i + 1);

      bookingOffsets.forEach((offset, b) => {
        const bookingId = `${BENCH_PREFIX}B${pad(c, 3)}-${pad(a, 4)}-${pad(b, 5)}`;
        const locationId = locationIds.length ? locationIds[b % locationIds.length] : null;

        bookings.push({
          sql:
            'insert into activity_bookings (id, activity_id, created_by, date, "from", "to", description, location, location_id, slack_message_ts, created) ' +
            "values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
          args: [
            bookingId,
            activityId,
            channelUsers[b % channelUsers.length],
            dateDaysFromNow(offset),
            "18:00",
            "20:00",
            "Seeded booking.",
            locationId ? "" : "Somewhere",
            locationId,
            `17000001.${pad(b, 6)}`,
            now,
          ],
        });

        const memberAttendees = Math.max(1, spec.attendeesPerBooking - 1);
        for (let t = 0; t < Math.min(memberAttendees, channelUsers.length); t++) {
          attendees.push({
            sql: "insert into activity_booking_attendees (id, booking_id, user_id, name) values (?, ?, ?, ?)",
            args: [`${bookingId}-T${pad(t, 3)}`, bookingId, channelUsers[t], null],
          });
        }
        // One guest per booking, so the `coalesce(users.name, attendees.name)`
        // branch in `shapeBookings` is exercised too.
        attendees.push({
          sql: "insert into activity_booking_attendees (id, booking_id, user_id, name) values (?, ?, ?, ?)",
          args: [`${bookingId}-G000`, bookingId, null, "A Guest"],
        });
      });
    }

    if (c === 0) {
      fixture = {
        scale,
        sessionId: `${BENCH_PREFIX}S${pad(c, 3)}`,
        userId: owner,
        channelId,
        persistentActivityId: persistentIds[0] ?? activityIds[0],
        cappedActivityId: persistentIds[0] ?? activityIds[0],
        // Beyond `respondersPerActivity`, so this user has no row yet.
        freshUserId: channelUsers[channelUsers.length - 1],
      };
    }
  }

  if (!fixture) throw new Error("scale must seed at least one channel");

  // Parents before children: foreign keys may or may not be enforced, but the
  // order costs nothing and keeps the seed valid either way.
  for (const group of [
    users,
    channels,
    members,
    sessions,
    activities,
    availability,
    locations,
    bookings,
    attendees,
  ]) {
    await runBatched(client, group);
  }

  return fixture;
};

export const connect = (url: string, authToken: string | undefined): Client =>
  createClient({ url, authToken });

export const countRows = async (client: Client) => {
  const tables = [
    "users",
    "channels",
    "sessions",
    "channel_members",
    "activities",
    "activity_availability",
    "activity_locations",
    "activity_bookings",
    "activity_booking_attendees",
  ];
  const counts: Record<string, number> = {};
  for (const table of tables) {
    const result = await client.execute(`select count(*) as n from ${table}`);
    counts[table] = Number(result.rows[0].n);
  }
  return counts;
};
