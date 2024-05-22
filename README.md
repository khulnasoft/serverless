# @khulnasoft/serverless [BETA]

`@khulnasoft/serverless` is [Khulnasoft](https://khulnasoft.com)'s PostgreSQL driver for JavaScript and TypeScript. It's:

* **Low-latency**, thanks to [message pipelining](https://khulnasoft.com/blog/quicker-serverless-postgres) and other optimizations
* **Ideal for serverless/edge** deployment, using https and WebSockets in place of TCP
* **A drop-in replacement** for [node-postgres](https://node-postgres.com/), aka [`pg`](https://www.npmjs.com/package/pg) (on which it's based)


## Get started


### Install it

Install it with your preferred JavaScript package manager. It's named `@khulnasoft/serverless` on npm and `@khulnasoft/serverless` on JSR. So, for example:

```bash
npm install @khulnasoft/serverless
```

or

```bash
bunx jsr add @khulnasoft/serverless
```

Using TypeScript? No worries: types are included either way.


### Configure it

Get your connection string from the [Khulnasoft console](https://console.khulnasoft.com/) and set it as an environment variable. Something like:

```
DATABASE_URL=postgres://username:password@host.khulnasoft.com/khulnasoftdb
```


### Use it

For one-shot queries, use the `khulnasoft` function. For instance:

```javascript
import { khulnasoft } from '@khulnasoft/serverless';
const sql = khulnasoft(process.env.DATABASE_URL);

const [post] = await sql`SELECT * FROM posts WHERE id = ${postId}`;
// `post` is now { id: 12, title: 'My post', ... } (or undefined)
```

Note: interpolating `${postId}` here is [safe from SQL injection](https://khulnasoft.com/blog/sql-template-tags).


### Deploy it

Turn this example into a complete API endpoint deployed on [Vercel Edge Functions](https://vercel.com/docs/concepts/functions/edge-functions) at `https://myapp.vercel.dev/api/post?postId=123` by following two simple steps:

1. Create a new file `api/post.ts`:

```javascript
import { khulnasoft } from '@khulnasoft/serverless';
const sql = khulnasoft(process.env.DATABASE_URL);

export default async (req: Request, ctx: any) => {
  // get and validate the `postId` query parameter
  const postId = parseInt(new URL(req.url).searchParams.get('postId'), 10);
  if (isNaN(postId)) return new Response('Bad request', { status: 400 });

  // query and validate the post
  const [post] = await sql`SELECT * FROM posts WHERE id = ${postId}`;
  if (!post) return new Response('Not found', { status: 404 });

  // return the post as JSON
  return new Response(JSON.stringify(post), { 
    headers: { 'content-type': 'application/json' }
  });
}

export const config = {
  runtime: 'edge',
  regions: ['iad1'],  // specify the region nearest your Khulnasoft DB
};
```

2. Test and deploy

```bash
npm install -g vercel  # install vercel CLI
npx vercel env add DATABASE_URL  # paste Khulnasoft connection string, select all environments
npx vercel dev  # check working locally, then ...
npx vercel deploy
```

The `khulnasoft` query function has a few [additional options](CONFIG.md).


## Sessions, transactions, and node-postgres compatibility

A query using the `khulnasoft` function, as shown above, is carried by an https [fetch](https://developer.mozilla.org/en-US/docs/Web/API/Fetch_API) request. 

This should work — and work fast — from any modern JavaScript environment. But you can only send one query at a time this way: sessions and transactions are not supported.


### `transaction()`

Multiple queries can be issued via fetch request within a single, non-interactive transaction by using the `transaction()` function. This is exposed as a property on the query function.

For example:

```javascript
import { khulnasoft } from '@khulnasoft/serverless';
const sql = khulnasoft(process.env.DATABASE_URL);
const showLatestN = 10;

const [posts, tags] = await sql.transaction([
  sql`SELECT * FROM posts ORDER BY posted_at DESC LIMIT ${showLatestN}`,
  sql`SELECT * FROM tags`,
]);
```

There are some [additional options](CONFIG.md) when using `transaction()`.


### `Pool` and `Client`

Use the `Pool` or `Client` constructors, instead of the functions described above, when you need:

* **session or interactive transaction support**, and/or

* **compatibility with node-postgres**, which supports query libraries like [Kysely](https://kysely.dev/) or [Zapatos](https://jawj.github.io/zapatos/).

Queries using `Pool` and `Client` are carried by WebSockets. There are **two key things** to know about this:

1. **In Node.js** and some other environments, there's no built-in WebSocket support. In these cases, supply a WebSocket constructor function.

2. **In serverless environments** such as Vercel Edge Functions or Cloudflare Workers, WebSocket connections can't outlive a single request. 
    
    That means `Pool` or `Client` objects must be connected, used and closed **within a single request handler**. Don't create them outside a request handler; don't create them in one handler and try to reuse them in another; and to avoid exhausting available connections, don't forget to close them.

These points are demonstrated in the examples below.


### API 

* **The full API guide** to `Pool` and `Client` can be found in the [node-postgres docs](https://node-postgres.com/).

* There are a few [additional configuration options](CONFIG.md) that apply to `Pool` and `Client` here.


## Example: Node.js with `Pool.connect()`

In Node.js, it takes two lines to configure WebSocket support. For example:

```javascript
import { Pool, khulnasoftConfig } from '@khulnasoft/serverless';

import ws from 'ws';
khulnasoftConfig.webSocketConstructor = ws;  // <-- this is the key bit

const pool = new Pool({ connectionString: process.env.DATABASE_URL });
pool.on('error', err => console.error(err));  // deal with e.g. re-connect
// ...

const client = await pool.connect();

try {
  await client.query('BEGIN');
  const { rows: [{ id: postId }] } = await client.query('INSERT INTO posts (title) VALUES ($1) RETURNING id', ['Welcome']);
  await client.query('INSERT INTO photos (post_id, url) VALUES ($1, $2)', [postId, 's3.bucket/photo/url']);
  await client.query('COMMIT');

} catch (err) {
  await client.query('ROLLBACK');
  throw err;

} finally {
  client.release();
}

// ...
await pool.end();
```

Other WebSocket libraries are available. For example, you could replace `ws` in the above example with `undici`:

```typescript
import { WebSocket } from 'undici';
khulnasoftConfig.webSocketConstructor = WebSocket; 
```


## Example: Vercel Edge Function with `Pool.query()`

We can rewrite the Vercel Edge Function shown above (under the heading 'Deploy it') to use `Pool`, as follows:

```javascript
import { Pool } from '@khulnasoft/serverless';

// *don't* create a `Pool` or `Client` here, outside the request handler

export default async (req: Request, ctx: any) => {
  // create a `Pool` inside the request handler
  const pool = new Pool({ connectionString: process.env.DATABASE_URL });

  // get and validate the `postId` query parameter
  const postId = parseInt(new URL(req.url).searchParams.get('postId'), 10);
  if (isNaN(postId)) return new Response('Bad request', { status: 400 });

  // query and validate the post
  const [post] = await pool.query('SELECT * FROM posts WHERE id = $1', [postId]);
  if (!post) return new Response('Not found', { status: 404 });

  // end the `Pool` inside the same request handler 
  // (unlike `await`, `ctx.waitUntil` won't hold up the response)
  ctx.waitUntil(pool.end());

  // return the post as JSON
  return new Response(JSON.stringify(post), { 
    headers: { 'content-type': 'application/json' }
  });
}

export const config = {
  runtime: 'edge',
  regions: ['iad1'],  // specify the region nearest your Khulnasoft DB
};
```

Note: we don't actually use the pooling capabilities of `Pool` in this example. But it's slightly briefer than using `Client` and, because `Pool.query` is designed for one-shot queries, we may in future automatically route these queries over https for lower latency.


## Example: Vercel Edge Function with `Client`

Using `Client` instead, the example looks like this:

```javascript
import { Client } from '@khulnasoft/serverless';

// don't create a `Pool` or `Client` here, outside the request handler

export default async (req: Request, ctx: any) => {
  // create a `Client` inside the request handler
  const client = new Client(process.env.DATABASE_URL);
  await client.connect();

  // get and validate the `postId` query parameter
  const postId = parseInt(new URL(req.url).searchParams.get('postId'), 10);
  if (isNaN(postId)) return new Response('Bad request', { status: 400 });

  // query and validate the post
  const [post] = await client.query('SELECT * FROM posts WHERE id = $1', [postId]);
  if (!post) return new Response('Not found', { status: 404 });

  // end the `Client` inside the same request handler 
  // (unlike `await`, `ctx.waitUntil` won't hold up the response)
  ctx.waitUntil(client.end());

  // return the post as JSON
  return new Response(JSON.stringify(post), { 
    headers: { 'content-type': 'application/json' }
  });
}

export const config = {
  runtime: 'edge',
  regions: ['iad1'],  // specify the region nearest your Khulnasoft DB
};
```

## More examples

These repos show how to use `@khulnasoft/serverless` with a variety of environments and tools:

* [Raw SQL + Vercel Edge Functions](https://github.com/khulnasoft/khulnasoft-vercel-rawsql)
* [Raw SQL via https + Vercel Edge Functions](https://github.com/khulnasoft/khulnasoft-vercel-http)
* [Raw SQL + Cloudflare Workers](https://github.com/khulnasoft/serverless-cfworker-demo)
* [Kysely + Vercel Edge Functions](https://github.com/khulnasoft/khulnasoft-vercel-kysely)
* [Zapatos + Vercel Edge Functions](https://github.com/khulnasoft/khulnasoft-vercel-zapatos)


## Bring your own Postgres database

This package comes configured to connect to a Khulnasoft database. But you can also use it to connect to your own Postgres instances if you [run your own WebSocket proxy](DEPLOY.md).


## Open-source

This code is released under the [MIT license](LICENSE).


## Feedback and support

Please visit [Khulnasoft Community](https://community.khulnasoft.com/) or [Support](https://khulnasoft.com/docs/introduction/support).