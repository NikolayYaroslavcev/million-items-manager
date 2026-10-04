# Million Items Manager

[Русский](README.md) · **English**

A test assignment: two lists over a million items (IDs from 1 to 1,000,000). The left one holds everything that is not selected, the right one holds the selected items. Selected items can be sorted by drag and drop, both lists are filtered by ID and load in batches of 20. The state is stored on the server and shared by everyone who opens the app: if you open two tabs, changes made in one show up in the other after about a second.

- Source code: https://github.com/NikolayYaroslavcev/million-items-manager
- Live demo: https://million-items-manager.onrender.com

![Million Items Manager](docs/screenshot.png)

Stack: Express and TypeScript on the server, React and Vite on the client, dnd-kit for drag and drop, zod for schemas shared by client and server. Tests with Vitest and Playwright, a pnpm monorepo.

## Running

You need Node.js 22.12 or newer (the version is in `.nvmrc`) and pnpm 11. The easiest way to get it is `corepack enable`.

```bash
pnpm i
pnpm dev                 # server on :3000 and Vite on :5173, /api is proxied to the server
pnpm build && pnpm start # production: one process serves both the API and the built frontend on :3000
```

With Docker:

```bash
docker build -t mim . && docker run -p 8080:8080 mim   # then open http://localhost:8080
```

All settings are set through environment variables, the list is in [.env.example](.env.example). `DEBUG_ENDPOINTS` and `SEED_SELECTED` are only needed for performance measurements. If you turn them on with `NODE_ENV=production`, the server refuses to start, so they can't be left on in production by accident.

## Tests

```bash
pnpm check               # lint, prettier, typecheck and unit/integration tests of all packages
pnpm test:large          # server tests on the full set of a million items
pnpm test:e2e            # build and Playwright against a real production server
pnpm test:perf           # measurements in the browser, the result is written to apps/web/perf-results.json
pnpm smoke http://localhost:3000          # a quick check of a live server (works for production too)
pnpm smoke https://<host> --long          # the same plus 5 minutes of SSE silence to check the proxy
pnpm build && pnpm --filter @mim/server load --duration 60 --connections 200   # load test
```

Before the first `pnpm test:e2e` you need to install the browser once: `pnpm --filter @mim/web exec playwright install chromium`.

GitHub Actions runs all of the same: checks and tests, e2e, a one-minute load test with 200 connections, and a Docker image build with a smoke test and a graceful shutdown check.

## How it works

```
packages/shared   zod schemas, error codes, response and event types, shared constants
apps/server
  src/store       data structures: a bitmap of selected items and a B+ tree of order keys
  src/core        tick engine, queues, idempotency, SSE, cursors
  src/http        Express: routes, validation, rate limit, errors
  src/runtime.ts  service assembly, graceful shutdown
  test/           unit, property, integration, fault injection; test/large for a million items
apps/web
  src/sync        synchronization without React: list mirror, queue of own operations, SSE, polling, tab leader
  src/api         HTTP client with timeouts and retries
  src/ui          virtualized lists, drag and drop, keyboard, adding IDs
  test/, e2e/     unit tests and Playwright scenarios
```

The server does not store a million objects. The base range 1..1,000,000 is computed on the fly, the selection is stored as a bitmap, and the order of selected items is defined by string keys in a B+ tree. Moving an item changes one key, and the others don't need to shift. If there is no room left between neighbors for a new key, the server regenerates keys only in a small neighborhood, which takes about 1.6 ms with a million selected items.

Requests pile up in a queue and are processed once a second, and new IDs are added once every 10 seconds, as the spec requires. Within a tick, additions go first, then changes in the order they arrived, then reads, so each page reflects one version of the data. Identical reads within one tick are executed once. Every mutation carries an `Idempotency-Key`: if the client repeats a request after a timeout, the operation is not applied a second time.

All changes are written to a journal with a version number. The client receives them over SSE, and if SSE doesn't work, it polls `/api/changes`. Tabs of the same browser negotiate among themselves, and only one of them holds the connection. On the client the list is stored as a loaded window plus the change journal, so when you scroll a list that others are changing at the same time, items don't disappear or get duplicated.

The state lives in the memory of the process, as the spec allows. When the server restarts, open tabs notice it (every response carries the process identifier `instance`) and reload the data themselves.

## What the spec required and where it is checked

| Requirement                                                 | How it is done                                                                                   | Tests                                                 |
| ----------------------------------------------------------- | ------------------------------------------------------------------------------------------------ | ----------------------------------------------------- |
| Two lists: unselected and selected                          | two panels, tabs on a phone; the lists are virtualized                                           | `e2e/app.spec.ts`                                     |
| A million items                                             | the range is computed, the selection is stored as a bitmap; the client holds only the loaded part | `large/million.test.ts`, `perf.spec.ts`               |
| Filter by ID in both lists                                  | substring search; if a batch comes out incomplete, the client loads more, showing progress       | `nextMatch.test.ts`, `large/million.test.ts`, e2e     |
| At most 20 at first, then in batches of 20                  | cursor pagination, the server never returns more than 20; the next batch loads on scroll        | `http.test.ts`, `e2e/app.spec.ts`                     |
| Adding new IDs without duplicates                           | checked on input, an "in queue" badge with a timer; a duplicate is rejected immediately          | `engine.test.ts`, `http.test.ts`, e2e                 |
| Sorting by drag and drop, including with a filter           | dnd-kit; the position is defined by the neighbors visible on screen; there are Alt+↑/↓ and a "To start / To end" menu | `store.test.ts`, `e2e/app.spec.ts`                    |
| After a reload the selection and order persist, filters don't | state on the server, filters live only in components                                           | `e2e/app.spec.ts`                                     |
| Data is shared by everyone                                  | SSE with one connection per browser, polling as a fallback                                       | `web/test/transport.test.ts`, `e2e/sync.spec.ts`      |
| Queue, deduplication, protection against repeated adding    | FIFO queue, merging identical reads within a tick, `Idempotency-Key`                             | `engine.test.ts`, `http.test.ts`, `atomicity.test.ts` |
| Adding once per 10 s, everything else once per second       | a tick scheduler without drift accumulation, additions run on every tenth tick                   | `engine.test.ts`                                      |

## What was verified

- A mutation is either applied in full or rolled back. In the tests a failure was injected after every write for every operation type.
- An operation with the same `Idempotency-Key` is not applied twice, even if the response was lost on the way.
- An SSE reconnect with `Last-Event-ID` sends the missed changes, and they match what `/api/changes` returns.
- After a server restart the client does not try to splice the old history with the new one, even if the new version number is higher.
- Load: 60 seconds, 200 connections, reads mixed with changes, including with a million selected items. There are no 5xx errors, and after the run the client state matches the server.
- The heaviest filter over a million selected items keeps the p99 event loop delay at about 23 ms, so other users don't notice it.

## Deployment

The live version runs on Render, the service is described in [render.yaml](render.yaml): a Docker image from this repository, a health check on `/api/health`, `NODE_ENV=production`. Every push to `main` is deployed automatically. On the free tier Render puts the service to sleep after 15 minutes without requests, so the first visit after a pause can take about a minute.

For Fly.io there is [fly.toml](fly.toml): one machine without auto-stop, 512 MB of memory, a health check on `/api/health`.

```bash
fly deploy --ha=false
pnpm smoke https://<app>.fly.dev --long
```
