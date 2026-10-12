# Database load-test harness

Measures æme's real database code paths — the functions in `src/worker`, not
re-written queries — against the local libsql container, at dataset sizes the
app hasn't reached yet.

```sh
docker compose up -d            # the turso container this points at
yarn bench --help
```

Run with `yarn bench [options]`, or `yarn bench:clean` to remove the seeded
rows. No build step and no loader: the files are `.ts` and Node runs them as
they are — type stripping is on by default from Node 23.6, and the imports
already carry `.ts` extensions the way the rest of the project writes them.

It only runs against `http://…`, and refuses anything else: every run seeds
tens of thousands of rows, and a hosted database is not the place for that.

## What it reports

For each scenario, three numbers that answer different questions:

| number                | what it tells you                                                                                                                       |
| --------------------- | --------------------------------------------------------------------------------------------------------------------------------------- |
| **round trips**       | How many times the request goes to the database _in series_. Locally this looks free; against a hosted Turso each one is a network hop. |
| **in db / in worker** | Where the wall time went. A large "in worker" figure means the cost is decoding rows and shaping them, not the query.                   |
| **received**          | Bytes the database sent back. The dashboard poll's payload is the thing that grows with the channel.                                    |

Round trips and the db/worker split come from one serial iteration; the
percentiles come from all of them.

## How it works

`run.ts` starts a recording proxy on a random port and hands the worker code an
`Env` pointing at it, so every libsql HTTP pipeline can be counted and timed
without touching `src/`. `--latency` delays each round trip to stand in for the
hop between a Cloudflare Worker and a hosted database — the single most
important flag here, because locally every query answers in under a
millisecond and a chain of seven of them looks the same as one.

`--explain` replays each captured statement (with its real arguments) under
`EXPLAIN QUERY PLAN`. A `SCAN` line is a full table scan.

Because Node strips types rather than checking them, `tsc -b` is what
actually typechecks this directory — `tsconfig.bench.json` is wired into the
root project references, so `yarn build` covers it.

## Options

```
--scenario <name>   Repeatable. Default: all.
                    dashboard, activities, session, history, members, channels, respond
--scale <size>      small | medium | large. Default: medium.
--iterations <n>    Measured runs per scenario. Default: 30.
--concurrency <n>   Runs in flight at once. Default: 1.
--latency <ms>      Injected per round trip. Default: 0.
--warmup <n>        Unmeasured runs first. Default: 3.
--skip-seed         Reuse the dataset a previous run seeded, e.g. to A/B a
                    schema change against identical data.
--clean             Delete the seeded rows and exit.
--sql               Print each round trip, in order, with what it cost.
--explain           As --sql, plus every statement's query plan.
--with-indexes      Apply the candidates in candidate-indexes.ts first.
--drop-indexes      Drop them again and exit.
```

Everything seeded has a `bench-` primary key and `--clean` deletes exactly
those rows, so the dev data in the container survives a run.

## Caveats

- All iterations share one Node process, so at high `--concurrency` the
  harness itself becomes the bottleneck. That is representative of a single
  Worker isolate, not of Cloudflare running many.
- The proxy buffers both directions, which adds a little to every round trip.
  Compare runs against each other, not against production numbers.
- `respond` is the only write scenario, and it refuses to run against a
  non-persistent activity: `upsertAvailability` announces one-offs to Slack,
  and a benchmark that posted a few hundred real messages would be a bad day.

## Scales

|                        | small | medium | large |
| ---------------------- | ----- | ------ | ----- |
| channels               | 1     | 3      | 6     |
| users per channel      | 12    | 60     | 250   |
| activities per channel | 7     | 28     | 80    |
| bookings               | ~70   | ~3k    | ~62k  |
| booking attendees      | ~350  | ~36k   | ~1.5M |

`small` is roughly today's shape; `large` is a deliberately pessimistic
ceiling, far past what a Slack channel realistically holds.
