import type { ReorderInput } from '../../src/store/store.js';

export type RefOutcome = { code: string | null; changed?: boolean };

export class ReferenceModel {
  readonly custom = new Set<number>();
  selected: number[] = [];

  constructor(readonly baseMax: number) {}

  exists(id: number): boolean {
    return (id >= 1 && id <= this.baseMax) || this.custom.has(id);
  }

  add(id: number, maxCustom = Infinity): RefOutcome {
    if (this.exists(id)) return { code: 'ALREADY_EXISTS' };
    if (this.custom.size >= maxCustom) return { code: 'CUSTOM_LIMIT_REACHED' };
    this.custom.add(id);
    return { code: null };
  }

  select(id: number): RefOutcome {
    if (!this.exists(id)) return { code: 'NOT_FOUND' };
    if (this.selected.includes(id)) return { code: null, changed: false };
    this.selected.push(id);
    return { code: null, changed: true };
  }

  deselect(id: number): RefOutcome {
    if (!this.exists(id)) return { code: 'NOT_FOUND' };
    const i = this.selected.indexOf(id);
    if (i < 0) return { code: null, changed: false };
    this.selected.splice(i, 1);
    return { code: null, changed: true };
  }

  reorder(input: ReorderInput): RefOutcome {
    const { id } = input;
    const a = input.afterId ?? null;
    const b = input.beforeId ?? null;
    if (input.position !== undefined) {
      if (a !== null || b !== null) return { code: 'INVALID_ANCHOR' };
    } else {
      if (a === null && b === null) return { code: 'INVALID_ANCHOR' };
      if (a === id || b === id || (a !== null && a === b)) return { code: 'INVALID_ANCHOR' };
    }
    const x = this.selected.indexOf(id);
    if (x < 0) return { code: 'NOT_SELECTED' };
    const rest = this.selected.filter((v) => v !== id);
    let at: number;
    if (input.position === 'first') at = 0;
    else if (input.position === 'last') at = rest.length;
    else {
      if (a !== null && !this.selected.includes(a)) return { code: 'ANCHOR_NOT_FOUND' };
      if (b !== null && !this.selected.includes(b)) return { code: 'ANCHOR_NOT_FOUND' };
      if (a !== null && b !== null && this.selected.indexOf(a) > this.selected.indexOf(b)) {
        return { code: 'ORDER_CONFLICT' };
      }
      at = a !== null ? rest.indexOf(a) + 1 : rest.indexOf(b!);
    }
    rest.splice(at, 0, id);
    const changed = rest.some((v, i) => v !== this.selected[i]);
    this.selected = rest;
    return { code: null, changed };
  }

  left(filter = ''): number[] {
    const out: number[] = [];
    const sel = new Set(this.selected);
    for (let id = 1; id <= this.baseMax; id++) {
      if (!sel.has(id) && String(id).includes(filter)) out.push(id);
    }
    for (const id of [...this.custom].sort((p, q) => p - q)) {
      if (!sel.has(id) && String(id).includes(filter)) out.push(id);
    }
    return out;
  }

  right(filter = ''): number[] {
    return this.selected.filter((id) => String(id).includes(filter));
  }
}
