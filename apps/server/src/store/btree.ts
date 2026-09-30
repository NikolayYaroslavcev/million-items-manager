import BTreeModule from 'sorted-btree';

const mod = BTreeModule as unknown as { default?: typeof BTreeModule };
export const BTree: typeof BTreeModule = mod.default ?? BTreeModule;
export type BTree<K, V> = BTreeModule<K, V>;

const compareStrings = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);
const compareNumbers = (a: number, b: number): number => a - b;

export function stringTree<V>(entries?: [string, V][]): BTree<string, V> {
  return new BTree<string, V>(entries, compareStrings);
}

export function numberTree<V>(entries?: [number, V][]): BTree<number, V> {
  return new BTree<number, V>(entries, compareNumbers);
}
