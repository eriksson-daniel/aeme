import { once } from "node:events";
import { createServer, request as httpRequest, type Server } from "node:http";

/** One HTTP round trip the worker made to the database. libsql's HTTP
 * transport posts a *pipeline* of statements per request, so `statements` is
 * usually more than one — the distinction matters: against a remote Turso the
 * round trips are what cost, not the statements inside them. */
export type Statement = {
  sql: string;
  /** Kept so a captured statement can be replayed under `EXPLAIN QUERY PLAN`
   * — a plan for the wrong parameters can pick a different index. */
  args: unknown[];
};

export type Call = {
  statements: Statement[];
  /** Milliseconds from receiving the worker's request to answering it,
   * including any injected latency. */
  durationMs: number;
  requestBytes: number;
  responseBytes: number;
};

export type Recorder = {
  /** Point `TURSO_DATABASE_URL` at this. */
  url: string;
  /** Drops everything recorded so far and starts a fresh window. */
  reset: () => void;
  /** The calls made since the last `reset`. */
  calls: () => Call[];
  close: () => Promise<void>;
};

/** The statements a batch wraps itself in. They're real round-trip content
 * but say nothing about what the query did, so the summary leaves them out. */
const TRANSACTION_CONTROL = /^\s*(begin|commit|rollback)\b/i;

/** libsql pipelines look like `{ requests: [{ type, stmt | batch }] }`. We
 * only ever read the SQL out, and a shape we don't recognise is counted as a
 * round trip with no statements rather than treated as an error.
 *
 * `storedSql` carries `sql_id → sql` across calls: a batch sends each
 * statement once as a `store_sql` request and then refers to it by id, in
 * this pipeline or a later one, so a map scoped to one call would see a
 * batch of anonymous ids. */
const extractStatements = (body: string, storedSql: Map<number, string>): Statement[] => {
  const statements: Statement[] = [];

  const push = (stmt: unknown) => {
    const parsed = stmt as {
      sql?: unknown;
      sql_id?: unknown;
      args?: { type?: string; value?: unknown }[];
    } | null;
    const sql =
      typeof parsed?.sql === "string"
        ? parsed.sql
        : typeof parsed?.sql_id === "number"
          ? storedSql.get(parsed.sql_id)
          : undefined;
    if (sql === undefined || TRANSACTION_CONTROL.test(sql)) return;
    // Hrana wraps every argument as `{ type, value }`; a null arrives as
    // `{ type: "null" }` with no value at all.
    const args = (parsed?.args ?? []).map((arg) => (arg?.type === "null" ? null : arg?.value));
    statements.push({ sql, args });
  };

  try {
    const parsed = JSON.parse(body) as {
      requests?: {
        type?: string;
        sql?: unknown;
        sql_id?: unknown;
        stmt?: unknown;
        batch?: { steps?: { stmt?: unknown }[] };
      }[];
    };
    for (const request of parsed.requests ?? []) {
      if (request.type === "store_sql" && typeof request.sql_id === "number") {
        if (typeof request.sql === "string") storedSql.set(request.sql_id, request.sql);
        continue;
      }
      if (request.stmt) push(request.stmt);
      for (const step of request.batch?.steps ?? []) push(step.stmt);
    }
  } catch {
    // Not JSON (or not a pipeline) — still a round trip, just an opaque one.
  }

  return statements;
};

const readBody = async (stream: NodeJS.ReadableStream): Promise<Buffer> => {
  const chunks: Buffer[] = [];
  for await (const chunk of stream) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks);
};

const decoder = new TextDecoder();

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** Stands between the worker code and the libsql server, recording every
 * round trip. Optionally delays each one by `latencyMs` to stand in for the
 * network between a Cloudflare Worker and a hosted Turso — locally every
 * query answers in well under a millisecond, which hides the one thing worth
 * measuring here: how many times a request goes to the database in series. */
export const startRecordingProxy = async (params: {
  target: string;
  latencyMs: number;
}): Promise<Recorder> => {
  const target = new URL(params.target);
  let calls: Call[] = [];
  const storedSql = new Map<number, string>();

  const server: Server = createServer((req, res) => {
    void (async () => {
      const startedAt = performance.now();
      const body = await readBody(req);

      if (params.latencyMs > 0) await sleep(params.latencyMs);

      const upstream = httpRequest(
        {
          hostname: target.hostname,
          port: target.port || 80,
          path: req.url,
          method: req.method,
          headers: { ...req.headers, host: target.host },
        },
        async (upstreamRes) => {
          const responseBody = await readBody(upstreamRes);
          calls.push({
            statements: extractStatements(decoder.decode(body), storedSql),
            durationMs: performance.now() - startedAt,
            requestBytes: body.byteLength,
            responseBytes: responseBody.byteLength,
          });
          res.writeHead(upstreamRes.statusCode ?? 502, upstreamRes.headers);
          res.end(responseBody);
        },
      );

      upstream.on("error", (error) => {
        res.writeHead(502, { "content-type": "text/plain" });
        res.end(String(error));
      });

      upstream.end(body);
    })();
  });

  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  if (typeof address === "string" || address === null) throw new Error("proxy failed to bind");

  return {
    url: `http://127.0.0.1:${address.port}`,
    reset: () => {
      calls = [];
    },
    calls: () => calls,
    close: async () => {
      server.closeAllConnections();
      server.close();
      await once(server, "close");
    },
  };
};
