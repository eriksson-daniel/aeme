import { parseArgs } from "node:util";

import type { Client, InArgs } from "@libsql/client";
import { config } from "dotenv";

import { CANDIDATE_INDEXES } from "./candidate-indexes.ts";
import {
  BENCH_PREFIX,
  clean,
  connect,
  countRows,
  type Fixture,
  SCALES,
  type Scale,
  seed,
} from "./dataset.ts";
import { startRecordingProxy, type Call, type Recorder, type Statement } from "./proxy.ts";
import { SCENARIOS, scenarioByName, type Scenario } from "./scenarios.ts";

config({ path: ".dev.vars" });

const { values } = parseArgs({
  options: {
    scenario: { type: "string", multiple: true },
    scale: { type: "string", default: "medium" },
    iterations: { type: "string", default: "30" },
    concurrency: { type: "string", default: "1" },
    latency: { type: "string", default: "0" },
    warmup: { type: "string", default: "3" },
    "skip-seed": { type: "boolean", default: false },
    clean: { type: "boolean", default: false },
    sql: { type: "boolean", default: false },
    explain: { type: "boolean", default: false },
    "with-indexes": { type: "boolean", default: false },
    "drop-indexes": { type: "boolean", default: false },
    help: { type: "boolean", default: false },
  },
});

if (values.help) {
  console.log(`
æme database load-test harness

  yarn bench [options]

  --scenario <name>   Scenario to run; repeatable. Default: all.
                      ${SCENARIOS.map((s) => s.name).join(", ")}
  --scale <size>      Dataset to seed: ${Object.keys(SCALES).join(", ")}. Default: medium.
  --iterations <n>    Measured runs per scenario. Default: 30.
  --concurrency <n>   Runs in flight at once. Default: 1.
  --latency <ms>      Delay injected into every database round trip, to stand
                      in for the hop from a Worker to a hosted Turso. Default: 0.
  --warmup <n>        Unmeasured runs first. Default: 3.
  --skip-seed         Reuse the dataset a previous run seeded, e.g. to A/B a
                      schema change against identical data.
  --clean             Delete the seeded rows and exit.
  --sql               Print each round trip of one iteration, in order, with
                      what it cost.
  --explain           As --sql, plus the query plan of every statement. A
                      "SCAN" line means a full table scan.
  --with-indexes      Create the candidate indexes first, to measure what
                      they would be worth. See bench/candidate-indexes.ts.
  --drop-indexes      Drop the candidate indexes and exit.
`);
  process.exit(0);
}

const databaseUrl = process.env.TURSO_DATABASE_URL;
const authToken = process.env.TURSO_AUTH_TOKEN;
if (!databaseUrl) throw new Error("TURSO_DATABASE_URL is not set (expected in .dev.vars)");
if (!databaseUrl.startsWith("http://")) {
  // The recording proxy speaks plain HTTP. Pointing this at a hosted database
  // would also mean seeding tens of thousands of rows into it.
  throw new Error(
    `refusing to run against ${databaseUrl} — point .dev.vars at the local container`,
  );
}

const scale = values.scale as Scale;
if (!(scale in SCALES)) throw new Error(`unknown scale "${scale}"`);

const iterations = Number(values.iterations);
const concurrency = Number(values.concurrency);
const latencyMs = Number(values.latency);
const warmup = Number(values.warmup);

const quantile = (sorted: number[], q: number) =>
  sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * q))];

const ms = (value: number) => `${value.toFixed(1)}ms`;

/** A statement, shortened to the part that says what it does: which tables,
 * and how many rows the `in (?, ?, …)` list carries. */
const summarise = (statements: Statement[]) =>
  statements
    .map((statement) => {
      const sql = statement.sql.replace(/\s+/g, " ");
      const verb = sql.slice(0, sql.indexOf(" "));
      const tables = [...sql.matchAll(/(?:from|join|into|update) "?([a-z_]+)"?/gi)].map(
        (match) => match[1],
      );
      const placeholders = statement.args.length;
      return (
        `${verb} ${[...new Set(tables)].join(" + ")}` +
        (placeholders ? ` (${placeholders} args)` : "")
      );
    })
    .join("; ");

/** Replays a captured statement under `EXPLAIN QUERY PLAN`. A line beginning
 * `SCAN` is the interesting one: it means SQLite walked the whole table. */
const queryPlan = async (client: Client, statement: Statement): Promise<string[]> => {
  try {
    const result = await client.execute({
      sql: `explain query plan ${statement.sql}`,
      args: statement.args as InArgs,
    });
    return result.rows.map((row) => String(row.detail));
  } catch (error) {
    return [`(plan unavailable: ${(error as Error).message.slice(0, 80)})`];
  }
};

type Measurement = {
  wallMs: number;
  /** Time the database was actually answering, summed over the round trips.
   * The gap between this and `wallMs` is work the worker itself did —
   * decoding the response and mapping it onto rows. */
  dbMs: number;
  roundTrips: number;
  statements: number;
  bytesIn: number;
  bytesOut: number;
};

const measureOnce = async (
  scenario: Scenario,
  env: Env,
  fixture: Fixture,
  recorder: Recorder,
): Promise<Measurement> => {
  recorder.reset();
  const startedAt = performance.now();
  await scenario.run(env, fixture);
  const wallMs = performance.now() - startedAt;
  const calls = recorder.calls();

  return {
    wallMs,
    dbMs: calls.reduce((sum, call) => sum + call.durationMs, 0),
    roundTrips: calls.length,
    statements: calls.reduce((sum, call) => sum + call.statements.length, 0),
    bytesIn: calls.reduce((sum, call) => sum + call.requestBytes, 0),
    bytesOut: calls.reduce((sum, call) => sum + call.responseBytes, 0),
  };
};

/** Round trips are counted from a serial run only. With several iterations in
 * flight the recorder can't tell whose call is whose, so concurrency measures
 * latency under contention and nothing else. */
const runScenario = async (
  scenario: Scenario,
  env: Env,
  fixture: Fixture,
  recorder: Recorder,
  client: Client,
  showSql: boolean,
  explain: boolean,
) => {
  for (let i = 0; i < warmup; i++) await scenario.run(env, fixture);

  const shape = await measureOnce(scenario, env, fixture, recorder);
  const shapeCalls: Call[] = recorder.calls().slice();

  const durations: number[] = [];
  let remaining = iterations;
  const startedAt = performance.now();

  const worker = async () => {
    while (remaining > 0) {
      remaining -= 1;
      const iterationStart = performance.now();
      await scenario.run(env, fixture);
      durations.push(performance.now() - iterationStart);
    }
  };
  await Promise.all(Array.from({ length: concurrency }, worker));

  const totalMs = performance.now() - startedAt;
  const sorted = [...durations].sort((a, b) => a - b);

  console.log(`\n── ${scenario.name} ${"─".repeat(Math.max(0, 56 - scenario.name.length))}`);
  console.log(`   ${scenario.description}`);
  console.log(
    `   round trips ${shape.roundTrips}  ·  statements ${shape.statements}  ·  ` +
      `sent ${(shape.bytesIn / 1024).toFixed(1)}KiB  ·  received ${(shape.bytesOut / 1024).toFixed(
        1,
      )}KiB`,
  );
  console.log(
    `   of one run: ${ms(shape.dbMs)} in the database, ` +
      `${ms(Math.max(0, shape.wallMs - shape.dbMs))} decoding and shaping it in the worker`,
  );
  console.log(
    `   p50 ${ms(quantile(sorted, 0.5))}  p90 ${ms(quantile(sorted, 0.9))}  ` +
      `p99 ${ms(quantile(sorted, 0.99))}  max ${ms(sorted[sorted.length - 1])}  ` +
      `· ${(iterations / (totalMs / 1000)).toFixed(1)} ops/s at concurrency ${concurrency}`,
  );
  // What a serial run would cost once each round trip carries a real network
  // hop — the number that makes a sequential query chain visible.
  if (latencyMs === 0) {
    console.log(
      `   at 30ms per round trip this would be ≈${ms(quantile(sorted, 0.5) + shape.roundTrips * 30)}`,
    );
  }

  if (showSql) {
    console.log("   round trips, in order:");
    for (const [i, call] of shapeCalls.entries()) {
      const label =
        `     ${String(i + 1).padStart(2)}. ${ms(call.durationMs).padStart(8)}  ` +
        `${(call.responseBytes / 1024).toFixed(1).padStart(6)}KiB`;
      console.log(`${label}  ${summarise(call.statements)}`);
      if (explain) {
        for (const statement of call.statements) {
          for (const line of await queryPlan(client, statement)) {
            console.log(`${" ".repeat(label.length)}  ↳ ${line}`);
          }
        }
      }
    }
  }

  return { scenario: scenario.name, shape, p50: quantile(sorted, 0.5) };
};

const main = async () => {
  const client = connect(databaseUrl, authToken);

  if (values["drop-indexes"]) {
    for (const index of CANDIDATE_INDEXES) {
      await client.execute(`drop index if exists ${index.name}`);
    }
    console.log(`dropped ${CANDIDATE_INDEXES.length} candidate index(es)`);
    client.close();
    return;
  }

  if (values.clean) {
    await clean(client);
    console.log("seeded rows removed");
    client.close();
    return;
  }

  let fixture: Fixture;
  if (values["skip-seed"]) {
    fixture = await seedless(client);
  } else {
    console.log(`seeding "${scale}" …`);
    const startedAt = performance.now();
    fixture = await seed(client, scale);
    console.log(`seeded in ${ms(performance.now() - startedAt)}`);
  }

  const counts = await countRows(client);
  console.log(
    Object.entries(counts)
      .map(([table, n]) => `  ${table}: ${n}`)
      .join("\n"),
  );

  if (values["with-indexes"]) {
    for (const index of CANDIDATE_INDEXES) await client.execute(index.sql);
    // No ANALYZE: the libsql server rejects it over the wire. Equality
    // lookups don't need sqlite_stat1 to pick an index, so the measurements
    // below still mean what they say.
    console.log(`\ncandidate indexes applied: ${CANDIDATE_INDEXES.map((i) => i.name).join(", ")}`);
  }

  const recorder = await startRecordingProxy({ target: databaseUrl, latencyMs });
  const env = {
    TURSO_DATABASE_URL: recorder.url,
    TURSO_AUTH_TOKEN: authToken,
  } as unknown as Env;

  console.log(
    `\nrunning ${iterations} iterations at concurrency ${concurrency}` +
      (latencyMs ? `, +${latencyMs}ms injected per round trip` : ""),
  );

  const chosen = values.scenario?.length ? values.scenario.map(scenarioByName) : SCENARIOS;
  const results = [];
  for (const scenario of chosen) {
    results.push(
      await runScenario(
        scenario,
        env,
        fixture,
        recorder,
        client,
        values.sql || values.explain,
        values.explain,
      ),
    );
  }

  console.log("\nsummary");
  console.log("  scenario       trips        p50     in db   in worker   received");
  for (const result of results) {
    console.log(
      `  ${result.scenario.padEnd(14)}${String(result.shape.roundTrips).padStart(5)}` +
        `${ms(result.p50).padStart(11)}${ms(result.shape.dbMs).padStart(10)}` +
        `${ms(Math.max(0, result.shape.wallMs - result.shape.dbMs)).padStart(12)}` +
        `${`${(result.shape.bytesOut / 1024).toFixed(1)}KiB`.padStart(11)}`,
    );
  }

  await recorder.close();
  client.close();
};

/** Rebuilds the fixture from rows a previous run already seeded, so
 * `--skip-seed` measures the same dataset again — against a changed schema,
 * say. It deliberately only looks at `bench-` rows: picking up whatever
 * happens to be in the dev database would silently measure a channel of one. */
const seedless = async (client: Client): Promise<Fixture> => {
  const first = async (sql: string, args: InArgs = []) =>
    (await client.execute({ sql, args })).rows[0];

  const like = `${BENCH_PREFIX}%`;
  const session = await first(
    "select id, user_id, channel_id from sessions where id like ? order by id limit 1",
    [like],
  );
  if (!session) throw new Error("--skip-seed found no seeded data — run once without it first");

  const channelId = session.channel_id as string;

  const persistent = await first(
    "select id from activities where channel_id = ? and persistent = 1 order by id limit 1",
    [channelId],
  );
  if (!persistent) throw new Error("--skip-seed found no seeded persistent activity");

  const capped = await first(
    "select id from activities where channel_id = ? and persistent = 1 and max_member_count is not null order by id limit 1",
    [channelId],
  );

  const fresh = await first(
    "select user_id from channel_members where channel_id = ? order by user_id desc limit 1",
    [channelId],
  );

  return {
    scale,
    sessionId: String(session.id),
    userId: String(session.user_id),
    channelId,
    persistentActivityId: String(persistent.id),
    cappedActivityId: String((capped ?? persistent).id),
    freshUserId: String(fresh?.user_id ?? session.user_id),
  };
};

await main();
