/** Indexes the schema doesn't have, kept here so `--with-indexes` can measure
 * what each is worth before any of them is committed to `db/schema.ts`.
 * SQLite doesn't index a foreign key just because it's declared, so every
 * `where column = ?` on a non-primary key is a full table scan until one of
 * these exists — run with `--explain` to see which scans remain.
 *
 * Names are prefixed so `--drop-indexes` can't touch a real one. */
export const CANDIDATE_INDEXES: { name: string; sql: string; why: string }[] = [
  {
    name: "bench_idx_activities_channel",
    sql: "create index if not exists bench_idx_activities_channel on activities (channel_id, archived)",
    why: "listActivitiesForChannel scans every activity in every channel on each 10s poll.",
  },
  {
    name: "bench_idx_bookings_activity_date",
    sql: "create index if not exists bench_idx_bookings_activity_date on activity_bookings (activity_id, date)",
    why: "The dashboard scans activity_bookings twice per poll (upcoming rows, then past counts), and the history route scans it again.",
  },
  {
    name: "bench_idx_channel_members_user",
    sql: "create index if not exists bench_idx_channel_members_user on channel_members (user_id)",
    why: "listChannelsForUser filters on user_id, but the only index is (channel_id, user_id) — wrong column order to help.",
  },
  {
    name: "bench_idx_sessions_expires",
    sql: "create index if not exists bench_idx_sessions_expires on sessions (expires)",
    why: "The scheduled cleanup deletes by expires, which otherwise scans every session.",
  },
  {
    name: "bench_idx_otp_logins_expires",
    sql: "create index if not exists bench_idx_otp_logins_expires on otp_logins (expires)",
    why: "Same, for the OTP half of the cleanup.",
  },
];
