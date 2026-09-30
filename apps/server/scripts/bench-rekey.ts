import { writeFileSync } from 'node:fs';
import { Store } from '../src/store/store.js';

interface Scenario {
  name: string;
  selected: number;
  ops: number;
  rekeyMaxSide?: number;
  keyMaxLen?: number;
  distinct: boolean;
}

const N = 1_000_000;
const scenarios: Scenario[] = [
  {
    name: 'global rebalance (old; REKEY_MAX_SIDE=0), 1M selected',
    selected: N,
    ops: 2000,
    rekeyMaxSide: 0,
    distinct: true,
  },
  {
    name: 'local re-key, 1M selected, 20k distinct IDs into one spot',
    selected: N,
    ops: 20_000,
    distinct: true,
  },
  {
    name: 'local re-key, 1M selected, 2 IDs alternating in one spot',
    selected: N,
    ops: 20_000,
    distinct: false,
  },
  {
    name: 'local re-key, 1M selected, KEY_MAX_LEN=16',
    selected: N,
    ops: 20_000,
    keyMaxLen: 16,
    distinct: true,
  },
  {
    name: 'local re-key, 100k selected, 20k distinct IDs',
    selected: 100_000,
    ops: 20_000,
    distinct: true,
  },
];

function run(sc: Scenario) {
  const store = new Store({
    baseMax: N,
    maxCustomIds: 500_000,
    keyMaxLen: sc.keyMaxLen ?? 128,
    changeLogSize: 10_000,
    instance: 'bench',
    ...(sc.rekeyMaxSide === undefined ? {} : { rekeyMaxSide: sc.rekeyMaxSide }),
  });
  const step = Math.floor(N / sc.selected);
  store.loadSelectedFixture(Array.from({ length: sc.selected }, (_, i) => 1 + i * step));
  const anchor = 1 + Math.floor(sc.selected / 2) * step;
  const successor = anchor + step;
  const mover = (i: number) => 1 + (sc.distinct ? i : i % 2) * step;
  global.gc?.();
  const heap0 = process.memoryUsage().heapUsed;
  const replica = new Map<number, string>();
  const times: number[] = [];
  let plainMaxMs = 0;
  let rekeys = 0;
  let globals = 0;
  let maxChanges = 0;
  let maxHeapMB = 0;
  const v0 = store.version;
  let journal = 0;
  for (let i = 0; i < sc.ops; i++) {
    const t = performance.now();
    const p = store.prepareReorder({ id: mover(i), afterId: anchor });
    if (!p.ok) throw p.error;
    store.commit(p.plan, []);
    const ms = performance.now() - t;
    journal += p.plan.changes.length;
    for (const c of p.plan.changes) if (c.type === 'moved') replica.set(c.id, c.key);
    if (p.plan.rebalanced) {
      globals++;
      for (const [id, key] of store.keyById) replica.set(id, key);
    }
    if (p.plan.changes.length > 1 || p.plan.rebalanced) {
      rekeys++;
      times.push(ms);
      maxChanges = Math.max(maxChanges, p.plan.changes.length);
      maxHeapMB = Math.max(maxHeapMB, (process.memoryUsage().heapUsed - heap0) / 1048576);
    } else plainMaxMs = Math.max(plainMaxMs, ms);
  }
  const errors: string[] = [];
  if (store.version - v0 !== journal) errors.push('version delta != journal entries');
  for (const [id, key] of replica) {
    if (store.keyOf(id) !== key) {
      errors.push(`replica key of ${id} differs`);
      break;
    }
  }
  const lastMove = new Map<number, number>();
  for (let i = 0; i < sc.ops; i++) lastMove.set(mover(i), i);
  const expected = [...lastMove].sort((a, b) => b[1] - a[1]).map(([id]) => id);
  const actual: number[] = [];
  let key = store.keyOf(anchor)!;
  for (let k = 0; k <= expected.length; k++) {
    key = store.orderTree.nextHigherKey(key)!;
    actual.push(store.orderTree.get(key)!);
  }
  if (JSON.stringify(actual) !== JSON.stringify([...expected, successor])) {
    errors.push('order after the anchor is wrong');
  }
  const ti = performance.now();
  try {
    store.assertInvariants();
  } catch (e) {
    errors.push((e as Error).message);
  }
  times.sort((a, b) => a - b);
  const q = (p: number) =>
    times.length ? +times[Math.floor((times.length - 1) * p)]!.toFixed(2) : 0;
  return {
    scenario: sc.name,
    selected: sc.selected,
    moves: sc.ops,
    rekeys,
    globalRebalances: globals,
    epoch: store.epoch,
    rekeyMs: { p50: q(0.5), p99: q(0.99), max: q(1) },
    plainMoveMaxMs: +plainMaxMs.toFixed(2),
    maxJournalEntriesPerMove: maxChanges,
    journalEntries: journal,
    maxHeapGrowthMB: Math.round(maxHeapMB),
    invariantsCheckMs: Math.round(performance.now() - ti),
    verified: errors.length === 0,
    errors,
  };
}

const results = [];
for (const sc of scenarios) {
  const r = run(sc);
  console.log(JSON.stringify(r));
  results.push(r);
}
const out = process.argv.includes('--out') ? process.argv[process.argv.indexOf('--out') + 1] : null;
if (out) {
  writeFileSync(
    out,
    JSON.stringify({ date: new Date().toISOString(), node: process.version, results }, null, 2) +
      '\n',
  );
}
process.exit(results.every((r) => r.verified) ? 0 : 1);
