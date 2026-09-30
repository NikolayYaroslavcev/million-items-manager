import { BASE_MAX, type LeftItem, type SelectedItem } from '@mim/shared';
import { matchesFilter, withinBound, type Bound } from './mirror.js';

export type OpKind = 'select' | 'deselect' | 'move' | 'add';

export interface OpInput {
  kind: OpKind;
  id: number;
  afterId?: number | null;
  beforeId?: number | null;
  position?: 'first' | 'last';
}

export interface PendingOp extends OpInput {
  opId: number;
  idempotencyKey: string;
  group: number | null;
  state: 'waiting' | 'sending' | 'applied';
  version: number | null;
  instance: string | null;
  createdAt: number;
  appliedAt: number | null;
}

export interface LeftRow extends LeftItem {
  pending?: boolean;
  queued?: boolean;
}

export interface RightRow {
  id: number;
  key: string | null;
  pending?: boolean;
}

export function opIds(op: OpInput): number[] {
  const ids = [op.id];
  if (typeof op.afterId === 'number') ids.push(op.afterId);
  if (typeof op.beforeId === 'number') ids.push(op.beforeId);
  return ids;
}

function insertById(rows: LeftRow[], row: LeftRow): void {
  let lo = 0;
  let hi = rows.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (rows[mid]!.id < row.id) lo = mid + 1;
    else hi = mid;
  }
  rows.splice(lo, 0, row);
}

export function leftView(
  items: readonly LeftItem[],
  end: Bound<number>,
  filter: string,
  ops: readonly PendingOp[],
): readonly LeftRow[] {
  let rows: LeftRow[] | null = null;
  const edit = (): LeftRow[] => (rows ??= items.slice());
  for (const op of ops) {
    const current: readonly LeftRow[] = rows ?? items;
    switch (op.kind) {
      case 'select': {
        const i = current.findIndex((r) => r.id === op.id);
        if (i >= 0) edit().splice(i, 1);
        break;
      }
      case 'deselect':
      case 'add': {
        if (!matchesFilter(op.id, filter) || !withinBound((a, b) => a - b, op.id, end)) break;
        const i = current.findIndex((r) => r.id === op.id);
        const queued = op.kind === 'add' && op.state !== 'applied';
        if (i >= 0) {
          if (queued && !current[i]!.queued) edit()[i] = { ...current[i]!, queued, pending: true };
          break;
        }
        insertById(edit(), {
          id: op.id,
          custom: op.id > BASE_MAX,
          pending: true,
          ...(queued ? { queued } : {}),
        });
        break;
      }
      case 'move':
        break;
    }
  }
  return rows ?? items;
}

export function rightView(
  items: readonly SelectedItem[],
  end: Bound<string>,
  filter: string,
  ops: readonly PendingOp[],
): readonly RightRow[] {
  let rows: RightRow[] | null = null;
  const edit = (): RightRow[] => (rows ??= items.slice());
  const done = end.kind === 'all';
  for (const op of ops) {
    const current: readonly RightRow[] = rows ?? items;
    const index = (id: number): number => current.findIndex((r) => r.id === id);
    switch (op.kind) {
      case 'select': {
        if (done && matchesFilter(op.id, filter) && index(op.id) < 0) {
          edit().push({ id: op.id, key: null, pending: true });
        }
        break;
      }
      case 'deselect': {
        const i = index(op.id);
        if (i >= 0) edit().splice(i, 1);
        break;
      }
      case 'move': {
        if (!matchesFilter(op.id, filter)) break;
        const from = index(op.id);
        const row: RightRow =
          from >= 0
            ? { ...current[from]!, pending: true }
            : { id: op.id, key: null, pending: true };
        const next = current.slice();
        if (from >= 0) next.splice(from, 1);
        let at = -1;
        if (op.position === 'first') at = 0;
        else if (op.position === 'last') at = done ? next.length : -1;
        else {
          const a =
            typeof op.afterId === 'number' ? next.findIndex((r) => r.id === op.afterId) : -1;
          const b =
            typeof op.beforeId === 'number' ? next.findIndex((r) => r.id === op.beforeId) : -1;
          if (a >= 0) at = a + 1;
          else if (b >= 0) at = b;
          else at = from;
        }
        if (at < 0 && from < 0) break;
        if (at >= 0) next.splice(at, 0, row);
        rows = next;
        break;
      }
      case 'add':
        break;
    }
  }
  return rows ?? items;
}
