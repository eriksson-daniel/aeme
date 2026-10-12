/** Indexes the schema doesn't have, kept here so `--with-indexes` can measure
 * what each is worth before any of them is committed to `db/schema.ts`.
 * SQLite doesn't index a foreign key just because it's declared, so every
 * `where column = ?` on a non-primary key is a full table scan until one of
 * these exists — run with `--explain` to see which scans remain.
 *
 * Names are prefixed so `--drop-indexes` can't touch a real one.
 *
 * Empty at the moment: the five this list started with all earned their place
 * and now live in `db/schema.ts` (see the `activities_channel_archived_created`
 * migration). Add the next candidate here rather than to the schema, so its
 * worth is a measurement rather than a guess. */
export const CANDIDATE_INDEXES: { name: string; sql: string; why: string }[] = [];
