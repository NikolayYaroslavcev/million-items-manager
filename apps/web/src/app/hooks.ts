import { useEffect, useMemo, useState, useSyncExternalStore } from 'react';
import { leftView, rightView, type LeftRow, type RightRow } from '../sync/overlay.js';
import type { Snapshot } from '../sync/engine.js';
import { engine } from './runtime.js';

export function useSnapshot(): Snapshot {
  return useSyncExternalStore(engine.subscribe, engine.getSnapshot);
}

export function useLeftRows(snap: Snapshot): readonly LeftRow[] {
  const { items, end, filter } = snap.left;
  return useMemo(() => leftView(items, end, filter, snap.ops), [items, end, filter, snap.ops]);
}

export function useRightRows(snap: Snapshot): readonly RightRow[] {
  const { items, end, filter } = snap.right;
  return useMemo(() => rightView(items, end, filter, snap.ops), [items, end, filter, snap.ops]);
}

export function useTicker(active: boolean, ms = 1000): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!active) return;
    const t = setInterval(() => setNow(Date.now()), ms);
    return () => clearInterval(t);
  }, [active, ms]);
  return now;
}

const nf = new Intl.NumberFormat('ru-RU');
export const fmt = (n: number): string => nf.format(n);

export type Theme = 'system' | 'light' | 'dark';

function readTheme(): Theme {
  try {
    const t = localStorage.getItem('mim-theme');
    return t === 'light' || t === 'dark' ? t : 'system';
  } catch {
    return 'system';
  }
}

export function useTheme(): [Theme, (t: Theme) => void] {
  const [theme, setTheme] = useState<Theme>(readTheme);
  useEffect(() => {
    const root = document.documentElement;
    if (theme === 'system') root.removeAttribute('data-theme');
    else root.setAttribute('data-theme', theme);
    try {
      localStorage.setItem('mim-theme', theme);
    } catch {}
  }, [theme]);
  return [theme, setTheme];
}
