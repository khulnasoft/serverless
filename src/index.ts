/* 
This file contains various checks that the driver is working.

Different elements can be run using:
  * `npm run node`, `npm run bun`, or `npm run browser`
  * `npm run cfDev` or `npm run cfDeploy`

In the long run these checks should be turned into a formal test suits.
*/

import * as subtls from 'subtls';

// @ts-ignore -- esbuild knows how to deal with this
import isrgRootX1 from './isrgrootx1.pem';

import { deepEqual } from 'fast-equals';
import { Client, Pool, khulnasoft, khulnasoftConfig } from '../export';
import { timedRepeats, runQuery, clientRunQuery, poolRunQuery, httpRunQuery } from './util';
import { queries } from './queries';

import type { ExecutionContext } from '@cloudflare/workers-types';

export { khulnasoftConfig } from '../export';

export interface Env {
  KHULNASOFT_DB_URL: string;
  MY_DB_URL: string;
}

// simple tests for Cloudflare Workers

export async function cf(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
  let results: any[] = [];

  for (const query of queries) {
    const [, [[, result]]] = await poolRunQuery(1, env.KHULNASOFT_DB_URL, ctx, query);
    results.push(result);
  }

  for (const query of queries) {
    const [, [[, result]]] = await httpRunQuery(1, env.KHULNASOFT_DB_URL, ctx, query);
    results.push(result);
  }

  return new Response(
    JSON.stringify(results, null, 2),
    { headers: { 'Content-Type': 'application/json' } },
  );
}

// latency + compatibility tests for browsers and node

const ctx = {
  waitUntil(promise: Promise<any>) { },
  passThroughOnException() { },
};

export async function batchQueryTest(env: Env, log = (...s: any[]) => { }) {
  const sql = khulnasoft(env.KHULNASOFT_DB_URL);

  // basic batch query with array instead of function
  const [[ra], [rb]] = await sql.transaction([
    sql`SELECT ${1}::int AS "batchInt"`,
    sql`SELECT ${"hello"} AS "batchStr"`
  ]);
  log('batch results:', JSON.stringify(ra), JSON.stringify(rb), '\n');
  if (ra.batchInt !== 1 || rb.batchStr !== 'hello') throw new Error('Batch query problem');

  // basic batch query
  const [[r1], [r2]] = await sql.transaction(txn => [
    txn`SELECT ${1}::int AS "batchInt"`,
    txn`SELECT ${"hello"} AS "batchStr"`
  ]);
  log('batch results:', JSON.stringify(r1), JSON.stringify(r2), '\n');
  if (r1.batchInt !== 1 || r2.batchStr !== 'hello') throw new Error('Batch query problem');

  // empty batch query
  const emptyResult = await sql.transaction(txn => []);
  log('empty txn result:', JSON.stringify(emptyResult), '\n');

  // option setting on `transaction()`
  const [[[r3]], [[r4]]] = await sql.transaction(txn => [
    txn`SELECT ${1}::int AS "batchInt"`,
    txn`SELECT ${"hello"} AS "batchStr"`
  ], { arrayMode: true, isolationLevel: 'Serializable', readOnly: true });
  log('array mode (via transaction options) batch results:', JSON.stringify(r3), JSON.stringify(r4), '\n');
  if (r3 !== 1 || r4 !== 'hello') throw new Error('Batch query problem');

  // option setting on `khulnasoft()`
  const sqlArr = khulnasoft(env.KHULNASOFT_DB_URL, { arrayMode: true, isolationLevel: 'RepeatableRead' });
  const [[[r5]], [[r6]]] = await sqlArr.transaction(txn => [
    txn`SELECT ${1}::int AS "batchInt"`,
    txn`SELECT ${"hello"} AS "batchStr"`
  ]);
  log('array mode (via khulnasoft options) batch results:', JSON.stringify(r5), JSON.stringify(r6), '\n');
  if (r5 !== 1 || r6 !== 'hello') throw new Error('Batch query problem');

  // option setting in transaction overrides option setting on Khulnasoft
  const sqlArr2 = khulnasoft(env.KHULNASOFT_DB_URL, { arrayMode: true });
  const [[r7], [r8]] = await sqlArr2.transaction(txn => [
    txn`SELECT ${1}::int AS "batchInt"`,
    txn`SELECT ${"hello"} AS "batchStr"`
  ], { arrayMode: false });
  log('ordinary (via overridden options) batch results:', JSON.stringify(r7), JSON.stringify(r8), '\n');
  if (r7.batchInt !== 1 || r8.batchStr !== 'hello') throw new Error('Batch query problem');

  // option setting on individual queries within a batch: should be honoured (despite types not supporting it)
  const [[r9], [r10]] = await sql.transaction(txn => [
    txn`SELECT ${1}::int AS "batchInt"`,
    txn('SELECT $1 AS "batchStr"', ['hello'], { arrayMode: true })
  ]);
  log('query options on individual batch queries:', JSON.stringify(r9), JSON.stringify(r10), '\n');
  if (r9.batchInt !== 1 || r10[0] !== 'hello') throw new Error('Batch query problem');

  // invalid query to `transaction()`
  let queryErr = undefined;
  try {
    // @ts-ignore
    await sql.transaction(txn => [
      txn`SELECT ${1}::int AS "batchInt"`,
      `SELECT 'hello' AS "batchStr"`
    ]);
  } catch (err) {
    queryErr = err;
  }
  if (queryErr === undefined) throw new Error('Error should have been raised for string passed to `transaction()`');
  log('caught invalid query passed to `transaction()`\n');

  // wrong DB URL
  let connErr;
  try {
    const urlWithBadPassword = env.KHULNASOFT_DB_URL.replace(/@/, 'x@');
    await khulnasoft(urlWithBadPassword).transaction(txn => [
      txn`SELECT 'never' AS this_should_be_seen_precisely`
    ]);
  } catch (err) {
    connErr = err;
  }
  if (connErr === undefined) throw new Error('Error should have been raised for bad password');
  log('caught invalid password passed to `khulnasoft()`\n');
}

export async function latencies(env: Env, useSubtls: boolean, log = (...s: any[]) => { }): Promise<void> {
  const queryRepeats = [1, 3];
  const connectRepeats = 9;

  log('Warm-up ...\n\n');
  await poolRunQuery(1, env.KHULNASOFT_DB_URL, ctx, queries[0]);

  let counter = 0;

  log(`\n===== SQL-over-HTTP tests =====\n\n`);

  const pgShowKeys = new Set(['command', 'rowCount', 'rows', 'fields']);

  const pool = await new Pool({ connectionString: env.KHULNASOFT_DB_URL });

  const sql = khulnasoft(env.KHULNASOFT_DB_URL, {
    resultCallback: async (query, result, rows, opts) => {
      const pgRes = await pool.query({
        text: query.query,
        values: query.params,
        ...(opts.arrayMode ? { rowMode: 'array' } : {}),
      });

      const commandMatches = result.command === pgRes.command;
      const rowCountMatches = result.rowCount === pgRes.rowCount;
      const dataTypesMatch = deepEqual(
        (result.fields as any[]).map(f => f.dataTypeID),
        pgRes.fields.map((f: any) => f.dataTypeID),
      );
      const rowsMatch = deepEqual(rows, pgRes.rows);
      const ok = commandMatches && rowCountMatches && rowsMatch && dataTypesMatch;

      log(ok ? '\u2713' : 'X', JSON.stringify(query), '\n  -> us:', JSON.stringify(rows), '\n  -> pg:', JSON.stringify(pgRes.rows), '\n');

      // if (!ok) {
      //   console.log('------');
      //   console.dir(query, { depth: null });
      //   console.log('-> raw result');
      //   console.dir(result, { depth: null });
      //   console.log('-> processed rows');
      //   console.dir(rows, { depth: null });
      //   console.log('-> pg result (abridged)');
      //   console.dir(Object.fromEntries(Object.entries(pgRes).filter(([k]) => pgShowKeys.has(k))), { depth: null });
      // }
    }
  });

  const now = new Date();

  await sql`SELECT ${1} AS int_uncast`;
  await sql`SELECT ${1}::int AS int`;
  await sql`SELECT ${1}::int8 AS int8num`;
  await sql`SELECT ${1}::decimal AS decimalnum`;
  await sql`SELECT ${'[1,4)'}::int4range AS int4range`;
  await sql`SELECT ${"hello"} AS str`;
  await sql`SELECT ${['a', 'b', 'c']} AS arrstr_uncast`;
  await sql`SELECT ${[[1, 2], [3, 4]]}::int[][] AS arrnumnested`;
  await sql`SELECT ${now}::timestamptz AS timestamptznow`;
  await sql`SELECT ${'16:17:18+01:00'}::timetz AS timetz`;
  await sql`SELECT ${'17:18:19'}::time AS time`;
  await sql`SELECT ${now}::date AS datenow`;
  await sql`SELECT ${{ "x": "y" }} AS obj_uncast`;
  await sql`SELECT ${'11:22:33:44:55:66'}::macaddr AS macaddr`;
  await sql`SELECT ${'\\xDEADBEEF'}::bytea AS bytea`;
  await sql`SELECT ${'(2, 3)'}::point AS point`;
  await sql`SELECT ${'<(2, 3), 1>'}::circle AS circle`;
  await sql`SELECT ${'10.10.10.0/24'}::cidr AS cidr`;
  await sql`SELECT ${true} AS bool_uncast`;  // 'true'
  await sql`SELECT ${'hello'} || ' ' || ${'world'} AS greeting`;
  await sql`SELECT ${[1, 2, 3]}::int[] AS arrnum`;
  await sql`SELECT ${['a', 'b', 'c']}::text[] AS arrstr`;
  await sql`SELECT ${{ "x": "y" }}::jsonb AS jsonb_obj`;
  await sql`SELECT ${{ "x": "y" }}::json AS json_obj`;
  await sql`SELECT ${['11:22:33:44:55:66']}::macaddr[] AS arrmacaddr`;
  await sql`SELECT ${['10.10.10.0/24']}::cidr[] AS arrcidr`;
  await sql`SELECT ${true}::boolean AS bool`;
  await sql`SELECT ${[now]}::timestamptz[] AS arrtstz`;
  await sql`SELECT ${['(2, 3)']}::point[] AS arrpoint`;
  await sql`SELECT ${['<(2, 3), 1>']}::circle[] AS arrcircle`;  // pg has no parser for this
  await sql`SELECT ${['\\xDEADBEEF', '\\xDEADBEEF']}::bytea[] AS arrbytea`;
  await sql`SELECT null AS null`;
  await sql`SELECT ${null} AS null`;  // us: "null", pg: null
  await sql`SELECT ${"NULL"} AS null_str`;
  await sql`SELECT ${[1, 2, 3]} AS arrnum_uncast`;  // us: '{1,2,3}', pg: '{"1","2","3"}' <-- pg imagines strings?
  await sql`SELECT ${[[1, 2], [3, 4]]} AS arrnumnested_uncast`;  // us: '{{1,2},{3,4}}', pg: '{{"1","2"},{"3","4"}}' <-- pg imagines strings?
  await sql`SELECT ${now} AS timenow_uncast`;  // us: '2023-05-26T13:35:22.616Z', pg: '2023-05-26T14:35:22.616+01:00' <-- different representations
  await sql`SELECT ${now}::timestamp AS timestampnow`;  // us: 2023-05-26T12:35:22.696Z, pg: 2023-05-26T13:35:22.696Z <-- different TZs

  // non-template usage
  await sql('SELECT $1::timestamp AS timestampnow', [now]);
  await sql("SELECT $1 || ' ' || $2 AS greeting", ['hello', 'world']);
  await sql('SELECT 123 AS num');
  await sql('SELECT 123 AS num', [], { arrayMode: true, fullResults: true });

  // timeout
  function sqlWithRetries(sql: ReturnType<typeof khulnasoft>, timeoutMs: number, attempts = 3) {
    return async function (strings: TemplateStringsArray, ...params: any[]) {
      // reassemble template string
      let query = '';
      for (let i = 0; i < strings.length; i++) {
        query += strings[i];
        if (i < params.length) query += '$' + (i + 1);
      }
      // run query with timeout and retries
      for (let i = 1; ; i++) {
        const abortController = new AbortController();
        const timeout = setTimeout(() => abortController.abort('fetch timed out'), timeoutMs);

        try {
          const { signal } = abortController;
          const result = await sql(query, params, { fetchOptions: { signal } });
          return result;

        } catch (err: any) {
          const timedOut = err.sourceError && err.sourceError instanceof DOMException && err.sourceError.name === 'AbortError';
          if (!timedOut || i >= attempts) throw err;

        } finally {
          clearTimeout(timeout);
        }
      }
    }
  }

  const sqlRetry = sqlWithRetries(sql, 5000);
  await sqlRetry`SELECT ${'did this time out?'} AS str`;

  // batch/transaction
  await batchQueryTest(env, log);

  // custom fetch
  khulnasoftConfig.fetchFunction = (url: string, options: any) => {
    console.log('custom fetch:', url, options);
    return fetch(url, options);
  };
  await sql`SELECT ${"customFetch"} AS str`;

  // errors
  const errstatement = 'SELECT 123::int[] WHERE x';
  try {
    await sql(errstatement);
  } catch (err) {
    console.log('Error fields should match following, except for having no length field');
    console.log(err);
  }
  try {
    await poolRunQuery(1, env.KHULNASOFT_DB_URL, ctx, { sql: errstatement, test: () => true });
  } catch (err) {
    console.log('Error fields should match previous, except for having additional length field');
    console.log(err);
  }

  await new Promise(resolve => setTimeout(resolve, 1000));
  pool.end();


  log(`\n\n===== Pool/Client tests =====\n`);

  for (const query of queries) {
    log(`\n----- ${query.sql} -----\n\n`);

    async function section(queryRepeat: number, f: (n: number) => Promise<void>) {
      const marker = String.fromCharCode(counter + (counter > 25 ? 49 - 26 : 65));  // A - Z, 1 - 9
      log(`${marker}\n`);

      // this will error, but makes for a handy heading in the dev tools Network pane (or Wireshark)
      try { await fetch(`http://localhost:443/${marker}`); } catch { }

      log(`<span class="live">Live:</span>    `)
      const [, results] = await timedRepeats(
        connectRepeats,
        () => f(queryRepeat),
        t => log(`<span class="live">${t.toFixed()}ms</span> `)
      );
      log('\nSorted:  ');

      // sort
      results.map(([t]) => t).sort((a, b) => a - b)
        .forEach((t, i) => {
          log(i === (connectRepeats - 1) / 2 ?
            `<span class="median">${t.toFixed()}ms</span> ` :
            `${t.toFixed()}ms `);
        });
      log('\n\n');
      counter += 1;
    }

    async function sections(title: string, f: (n: number) => Promise<void>) {
      log(`----- ${title} -----\n\n`);
      for (let queryRepeat of queryRepeats) {
        log(`${queryRepeat} quer${queryRepeat === 1 ? 'y' : 'ies'} – `)
        await section(queryRepeat, f);
      }
    }

    await sections('Khulnasoft/wss, no pipelining', async n => {
      const client = new Client(env.KHULNASOFT_DB_URL);
      client.khulnasoftConfig.pipelineConnect = false;
      await clientRunQuery(n, client, ctx, query);
    });

    await sections('Khulnasoft/wss, pipelined connect (default)', async n => {
      const client = new Client(env.KHULNASOFT_DB_URL);
      await clientRunQuery(n, client, ctx, query);
    });

    await sections('Khulnasoft/wss, pipelined connect, no coalescing', async n => {
      const client = new Client(env.KHULNASOFT_DB_URL);
      client.khulnasoftConfig.coalesceWrites = false;
      await clientRunQuery(n, client, ctx, query);
    });

    await sections('Khulnasoft/wss, pipelined connect using Pool.query', async n => {
      await poolRunQuery(n, env.KHULNASOFT_DB_URL, ctx, query);
    });

    await sections('Khulnasoft/wss, pipelined connect using Pool.connect', async n => {
      const pool = new Pool({ connectionString: env.KHULNASOFT_DB_URL });
      const poolClient = await pool.connect();
      await timedRepeats(n, () => runQuery(poolClient, query));
      poolClient.release();
      ctx.waitUntil(pool.end());
    });

    if (useSubtls) {
      khulnasoftConfig.subtls = subtls;
      khulnasoftConfig.rootCerts = isrgRootX1;

      await sections('pg/subtls, pipelined connect', async n => {
        const client = new Client(env.KHULNASOFT_DB_URL);
        client.khulnasoftConfig.wsProxy = (host, port) => `subtls-wsproxy.jawj.workers.dev/?address=${host}:${port}`;
        client.khulnasoftConfig.forceDisablePgSSL = client.khulnasoftConfig.useSecureWebSocket = false;
        client.khulnasoftConfig.pipelineTLS = false;  // only works with patched pg
        client.khulnasoftConfig.pipelineConnect = false;  // only works with password auth, which we aren't offered this way
        try {
          await clientRunQuery(n, client, ctx, query);
        } catch (err: any) {
          console.error(`\n*** ${err.message}`);
        }
      });
    }
  }
}
