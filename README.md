# Reproduction: synchronous imports leak a Postgres transaction

Minimal reproduction for `@payloadcms/plugin-import-export` with `import: { disableJobsQueue: true }`
on `@payloadcms/db-postgres`, based on `create-payload-app -t blank` (Payload 3.92.1).

Every synchronous import leaves its own create transaction open: it is never committed or rolled back.
The pooled connection stays `idle in transaction`, and the `imports` document is never stored, although
the imported documents themselves are. After as many imports as the pool has connections (10 by
default), every request (including login) waits for a connection and the app stops responding until
the process restarts. Postgres does not end these sessions by default
(`idle_in_transaction_session_timeout` is off), and terminating them on the database side does not
return the clients to the Node pool.

## What is in this repository

| File | Purpose |
| --- | --- |
| `src/collections/Authors.ts`, `src/collections/Posts.ts` | Posts have a relationship to authors. |
| `src/payload.config.ts` | `importExportPlugin({ collections: [{ slug: 'posts', import: { disableJobsQueue: true } }] })` |
| `tests/int/import-transaction.int.spec.ts` | Imports a post through the Local API and checks for open transactions and the stored import document. |
| `src/importTransactionWorkaround.ts` | Opt-in workaround, enabled with `APPLY_WORKAROUND=true`. |
| `docker-compose.yml` | Postgres 17 on port 5433. |

## Steps to reproduce

```sh
cp .env.example .env            # set any PAYLOAD_SECRET
docker compose up -d            # Postgres on port 5433
pnpm install
pnpm test:int
```

Expected: all tests pass.

Actual on 3.92.1:

```
✓ imports the post
× commits the import transaction instead of leaving it open   (expected 2 to be 1)
× stores the import document                                  (expected +0 to be 1)
```

- `imports the post` passes: the post itself is imported.
- `commits the import transaction instead of leaving it open` fails: after each import there is one more
  open adapter session (`payload.db.sessions`) and one more `idle in transaction` connection.
- `stores the import document` fails: the `imports` document does not exist after the import.

### Through the REST API

```sh
pnpm dev
```

Create a user in the admin, add an author, and save a file `posts.json`:

```json
[{ "title": "Imported post", "author": 1 }]
```

Then import it a few times with a token from `POST /api/users/login`:

```sh
curl -X POST http://localhost:3000/api/imports \
  -H "Authorization: JWT <token>" \
  -F '_payload={"collectionSlug":"posts","importMode":"create"}' \
  -F 'file=@posts.json;type=application/json'
```

And watch the open transactions:

```sh
docker compose exec postgres psql -U postgres -d payload_import_issue -c \
  "select count(*) from pg_stat_activity where datname = current_database() and state = 'idle in transaction'"
```

Observed on 3.92.1: each import returns `201` and creates the post, but adds one `idle in transaction`
connection, and `select count(*) from imports` does not change. After 8 imports the 9th import hangs,
and from then on every request that needs the database (for example `POST /api/users/login`) hangs too.

## Cause

`processImportBatch` (`packages/plugin-import-export/src/import/batchProcessor.ts`) isolates
`transactionID` on the request copy it uses for each document, but the copy still shares the parent
request's `payloadDataLoader`. When a document with a relationship is populated, the DataLoader batch
function (`packages/payload/src/collections/dataloader.ts`) sets `req.transactionID` on the request it
was created with, which is the parent import request. The parent's transaction ID is overwritten (and
later cleared), so `createOperation` never commits the transaction it opened for the `imports` document.

Isolating `payloadDataLoader` as well fixes it. That change already exists on `main` (as part of #17247)
but not on `3.x`:

```ts
const req = isolateObjectProperty(reqFromArgs, ['payloadDataLoader', 'transactionID'])
req.transactionID = undefined
req.payloadDataLoader = getDataLoader(req)
```

With this change applied to `batchProcessor.js` in `node_modules`, all tests in this repository pass.

## Workaround

Until the fix is released for v3, the plugin's import hooks can run with a DataLoader bound to an
isolated request, through the plugin's `overrideImportCollection` option
([`src/importTransactionWorkaround.ts`](src/importTransactionWorkaround.ts)):

```ts
import { getDataLoader, isolateObjectProperty } from 'payload'
import type { CollectionAfterChangeHook, CollectionConfig } from 'payload'

const withIsolatedImportTransaction =
  (hook: CollectionAfterChangeHook): CollectionAfterChangeHook =>
  async (args) => {
    const { req } = args
    const dataLoader = req.payloadDataLoader
    req.payloadDataLoader = getDataLoader(isolateObjectProperty(req, 'transactionID'))

    try {
      return await hook(args)
    } finally {
      req.payloadDataLoader = dataLoader
    }
  }

export const overrideImportCollection = ({ collection }: { collection: CollectionConfig }) => ({
  ...collection,
  hooks: {
    ...collection.hooks,
    afterChange: (collection.hooks?.afterChange ?? []).map(withIsolatedImportTransaction),
  },
})
```

```ts
importExportPlugin({
  collections: [{ slug: 'posts', import: { disableJobsQueue: true } }],
  overrideImportCollection,
})
```

Already leaked connections are not released by the workaround; restart the process once after
deploying it.

## Verification

Run the tests with and without the workaround on a fresh database:

```sh
docker compose down -v && docker compose up -d
pnpm test:int                          # 2 failed | 2 passed

docker compose down -v && docker compose up -d
APPLY_WORKAROUND=true pnpm test:int    # 4 passed
```

Through the REST API, start the app with `APPLY_WORKAROUND=true pnpm dev` and repeat the import steps
above. Results observed with the workaround: 12 imports in a row all returned `201`, the
`idle in transaction` count stayed at 0, every import document was stored with status `completed`,
and login still answered in under 100 ms.
