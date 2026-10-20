import { sql } from "drizzle-orm";
import { check, index, integer, sqliteTable, text, uniqueIndex } from "drizzle-orm/sqlite-core";

export const usersTable = sqliteTable(
  "users",
  {
    userId: text("user_id").primaryKey(),
    name: text().notNull(),
    /** Lowercase `#rrggbb`, used to tell people apart in availability grids.
     * Handed out from `USER_COLOR_PALETTE` when the row is created (see
     * `ensureUserStatement`), and changeable by the user afterwards. */
    color: text().notNull(),
    created: text().notNull(),
  },
  (t) => [
    check(
      "users_color_hex",
      sql`${t.color} GLOB '#[0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f]'`,
    ),
  ],
);

export const channelsTable = sqliteTable("channels", {
  channelId: text("channel_id").primaryKey(),
  name: text().notNull(),
  owner: text("owner")
    .notNull()
    .references(() => usersTable.userId, { onDelete: "restrict" }),
  created: text().notNull(),
});

export const otpLoginsTable = sqliteTable(
  "otp_logins",
  {
    otpHash: text("otp_hash").primaryKey(),
    userId: text("user_id")
      .notNull()
      .references(() => usersTable.userId, { onDelete: "cascade" }),
    channelId: text("channel_id")
      .notNull()
      .references(() => channelsTable.channelId, { onDelete: "cascade" }),
    created: text().notNull(),
    expires: text().notNull(),
  },
  (t) => [
    check(
      "otp_hash_sha256_hex",
      sql`length(${t.otpHash}) = 64 AND ${t.otpHash} NOT GLOB '*[^a-f0-9]*'`,
    ),
    // The scheduled cleanup deletes by `expires`; without this it walks every
    // row to find the handful that have lapsed.
    index("otp_logins_expires").on(t.expires),
  ],
);

export const sessionsTable = sqliteTable(
  "sessions",
  {
    id: text().primaryKey(),
    userId: text("user_id")
      .notNull()
      .references(() => usersTable.userId, { onDelete: "cascade" }),
    channelId: text("channel_id")
      .notNull()
      .references(() => channelsTable.channelId, { onDelete: "cascade" }),
    created: text().notNull(),
    expires: text().notNull(),
  },
  // Same as `otp_logins_expires`: the other half of the scheduled cleanup.
  (t) => [index("sessions_expires").on(t.expires)],
);

/** Durable record that a user belongs to a channel — a user can be a member
 * of multiple channels on the same Slack workspace. Recorded either when they
 * interact with æme from that channel for real (see `ensureChannelMember`),
 * or pre-loaded from Slack's live member list before they've ever logged in
 * (see the profile page's "Add" action) — not kept in sync with Slack after
 * that, just a one-time snapshot either way. */
export const channelMembersTable = sqliteTable(
  "channel_members",
  {
    id: text().primaryKey(),
    channelId: text("channel_id")
      .notNull()
      .references(() => channelsTable.channelId, { onDelete: "cascade" }),
    userId: text("user_id")
      .notNull()
      .references(() => usersTable.userId, { onDelete: "cascade" }),
    joined: text().notNull(),
  },
  (t) => [
    uniqueIndex("channel_members_channel_user").on(t.channelId, t.userId),
    // `listChannelsForUser` filters on `user_id` alone, which the unique
    // index above can't serve — it leads with `channel_id`.
    index("channel_members_user").on(t.userId),
  ],
);

export type ActivitySlot = {
  date: string;
  from?: string;
  to?: string;
};

export const activitiesTable = sqliteTable(
  "activities",
  {
    id: text().primaryKey(),
    channelId: text("channel_id")
      .notNull()
      .references(() => channelsTable.channelId, { onDelete: "cascade" }),
    /** Only the creator may edit an activity, so this must always be set —
     * a null would leave the activity editable by nobody. */
    createdBy: text("created_by")
      .notNull()
      .references(() => usersTable.userId, { onDelete: "restrict" }),
    title: text().notNull(),
    description: text().notNull(),
    /** Respond-by deadline, as a UTC instant (`…Z`). Stored as an instant
     * rather than the creator's wall clock so the server and client can
     * compare it to `new Date()` and agree — see the format check below. */
    endTime: text("end_time"),
    persistent: integer({ mode: "boolean" }).notNull().default(false),
    slotGranularity: text("slot_granularity", { enum: ["day", "hourly"] })
      .notNull()
      .default("day"),
    suggestedDates: text("suggested_dates", { mode: "json" }).$type<string[]>(),
    /** Advisory headcount the organizer is aiming for — purely informational
     * (e.g. shown as "5/8 going"), never enforced as a cap on responses or
     * booking attendees. */
    idealMemberCount: integer("ideal_member_count"),
    /** Hard cap on headcount, unlike `idealMemberCount`: no day/hour can be
     * picked by more people (+1s included), and no booking can include more
     * (members plus named guests). */
    maxMemberCount: integer("max_member_count"),
    /** Slack message timestamp of the suggestion announcement for a
     * non-persistent activity (see `activity_bookings.slack_message_ts` for
     * the analogous field on a booking), so it can be edited in place
     * instead of re-posted. Null for persistent activities, which aren't
     * announced this way. */
    slackMessageTs: text("slack_message_ts"),
    archived: integer({ mode: "boolean" }).notNull().default(false),
    created: text().notNull(),
  },
  (t) => [
    // The dashboard poll's `where channel_id = ? and archived = 0 order by
    // created` — `created` is in the index so the ordering comes out of it
    // too, rather than a temp b-tree.
    index("activities_channel_archived_created").on(t.channelId, t.archived, t.created),
    check("activities_persistent_no_end_time", sql`${t.persistent} = 0 OR ${t.endTime} IS NULL`),
    // The other half of the same rule. Its absence was load-bearing: the
    // Slack announcement asserts `endTime!` for a one-off.
    check("activities_oneoff_has_end_time", sql`${t.persistent} = 1 OR ${t.endTime} IS NOT NULL`),
    check(
      "activities_end_time_utc",
      sql`${t.endTime} IS NULL OR ${t.endTime} GLOB '[0-9][0-9][0-9][0-9]-[0-1][0-9]-[0-3][0-9]T[0-2][0-9]:[0-5][0-9]:[0-5][0-9].[0-9][0-9][0-9]Z'`,
    ),
    check(
      "activities_suggested_dates_json",
      sql`${t.suggestedDates} IS NULL OR (json_valid(${t.suggestedDates}) AND json_array_length(${t.suggestedDates}) > 0)`,
    ),
    check("activities_slot_granularity_valid", sql`${t.slotGranularity} IN ('day', 'hourly')`),
    check(
      "activities_persistent_no_suggested_dates",
      sql`${t.persistent} = 0 OR ${t.suggestedDates} IS NULL`,
    ),
    check(
      "activities_ideal_member_count_positive",
      sql`${t.idealMemberCount} IS NULL OR ${t.idealMemberCount} > 0`,
    ),
    check(
      "activities_max_member_count_positive",
      sql`${t.maxMemberCount} IS NULL OR ${t.maxMemberCount} > 0`,
    ),
    check(
      "activities_ideal_within_max",
      sql`${t.idealMemberCount} IS NULL OR ${t.maxMemberCount} IS NULL OR ${t.idealMemberCount} <= ${t.maxMemberCount}`,
    ),
  ],
);

export const activityAvailabilityTable = sqliteTable(
  "activity_availability",
  {
    id: text().primaryKey(),
    activityId: text("activity_id")
      .notNull()
      .references(() => activitiesTable.id, { onDelete: "cascade" }),
    userId: text("user_id")
      .notNull()
      .references(() => usersTable.userId, { onDelete: "cascade" }),
    slots: text({ mode: "json" }).notNull().$type<ActivitySlot[]>(),
    /** Explicitly "I can't make it", as opposed to just not having answered
     * yet — mutually exclusive with having any slots selected. Only
     * surfaced for one-off activities; persistent ones always send `false`. */
    declined: integer({ mode: "boolean" }).notNull().default(false),
    /** "I'm bringing someone." A flag rather than a count — one guest each is
     * the only case worth modelling, and it keeps the headcount arithmetic
     * honest. The guest is anonymous here: whoever books is responsible for
     * typing a name into the booking's guest list. */
    plusOne: integer("plus_one", { mode: "boolean" }).notNull().default(false),
    created: text().notNull(),
    updated: text().notNull(),
  },
  (t) => [
    uniqueIndex("activity_availability_activity_user").on(t.activityId, t.userId),
    check(
      "activity_availability_slots_json",
      sql`json_valid(${t.slots}) AND json_type(${t.slots}) = 'array'`,
    ),
    check(
      "activity_availability_declined_no_slots",
      sql`${t.declined} = 0 OR json_array_length(${t.slots}) = 0`,
    ),
    check("activity_availability_declined_no_plus_one", sql`${t.declined} = 0 OR ${t.plusOne} = 0`),
  ],
);

/** An actual booked occurrence of an activity — as opposed to `activity_availability`,
 * which only records when users say they *could* meet. Any user in the channel can
 * add one. Persistent activities may accrue many bookings over time; non-persistent
 * (one-off) activities will typically end up with just the one. */
export const activityBookingsTable = sqliteTable(
  "activity_bookings",
  {
    id: text().primaryKey(),
    activityId: text("activity_id")
      .notNull()
      .references(() => activitiesTable.id, { onDelete: "cascade" }),
    createdBy: text("created_by")
      .notNull()
      .references(() => usersTable.userId, { onDelete: "restrict" }),
    date: text().notNull(),
    from: text().notNull(),
    to: text().notNull(),
    description: text().notNull().default(""),
    /** Free-text place, used only when no `locationId` is set — the two are
     * mutually exclusive, enforced by `activity_bookings_location_xor`. */
    location: text().notNull().default(""),
    /** One of the activity's fixed locations, when the booker picked one
     * instead of typing a place. Always null for a non-persistent activity,
     * which has no fixed locations to pick. */
    locationId: text("location_id").references(() => activityLocationsTable.id, {
      onDelete: "set null",
    }),
    /** Slack message timestamp of the announcement post for this booking, so
     * it can be edited in place (via `chat.update`) instead of re-posted as
     * the booking's data changes. Null until the post succeeds. */
    slackMessageTs: text("slack_message_ts"),
    created: text().notNull(),
  },
  (t) => [
    // Every booking read filters by activity and slices by date: the
    // dashboard twice per poll (what's still to come, then how much is
    // past), and `listPastBookingsForActivity` again. Without this each of
    // those walks every booking in every channel.
    index("activity_bookings_activity_date").on(t.activityId, t.date),
    check(
      "activity_bookings_date_format",
      sql`${t.date} GLOB '[0-9][0-9][0-9][0-9]-[0-1][0-9]-[0-3][0-9]'`,
    ),
    // A booking carries a fixed location or free text, never both.
    check("activity_bookings_location_xor", sql`${t.locationId} IS NULL OR ${t.location} = ''`),
    check(
      "activity_bookings_time_format",
      sql`${t.from} GLOB '[0-2][0-9]:[0-5][0-9]' AND ${t.to} GLOB '[0-2][0-9]:[0-5][0-9]'`,
    ),
    check("activity_bookings_from_before_to", sql`${t.from} < ${t.to}`),
  ],
);

/** A named place a persistent activity repeats at — "the court", "the usual
 * pub" — so booking one doesn't mean retyping the same address every week.
 * Only persistent activities have these (enforced by the router, not a check
 * constraint: SQLite can't express a cross-table one). Picking one is never
 * required; a booking can still carry free-text `location` instead.
 *
 * Retired places are archived rather than deleted, so bookings that already
 * reference them keep rendering — see `archiveActivityLocation`. */
export const activityLocationsTable = sqliteTable(
  "activity_locations",
  {
    id: text().primaryKey(),
    activityId: text("activity_id")
      .notNull()
      .references(() => activitiesTable.id, { onDelete: "cascade" }),
    name: text().notNull(),
    mapsUrl: text("maps_url").notNull(),
    archived: integer({ mode: "boolean" }).notNull().default(false),
    created: text().notNull(),
  },
  (t) => [
    // Partial, so archiving a place frees its name for re-use rather than
    // blocking it forever.
    uniqueIndex("activity_locations_activity_name")
      .on(t.activityId, t.name)
      .where(sql`${t.archived} = 0`),
    check("activity_locations_name_not_empty", sql`length(trim(${t.name})) > 0`),
    check("activity_locations_maps_url_not_empty", sql`length(trim(${t.mapsUrl})) > 0`),
  ],
);

/** An attendee is either a channel member (`userId` set, tagged via Slack
 * `<@userId>` mentions) or a guest with no Slack account (`name` set, listed
 * by plain name only — never attempted to be tagged) — exactly one of the
 * two, enforced below. */
export const activityBookingAttendeesTable = sqliteTable(
  "activity_booking_attendees",
  {
    id: text().primaryKey(),
    bookingId: text("booking_id")
      .notNull()
      .references(() => activityBookingsTable.id, { onDelete: "cascade" }),
    userId: text("user_id").references(() => usersTable.userId, { onDelete: "cascade" }),
    name: text(),
  },
  (t) => [
    uniqueIndex("activity_booking_attendees_booking_user").on(t.bookingId, t.userId),
    check(
      "activity_booking_attendees_user_or_name",
      sql`(${t.userId} IS NOT NULL AND ${t.name} IS NULL) OR (${t.userId} IS NULL AND length(trim(${t.name})) > 0)`,
    ),
  ],
);
