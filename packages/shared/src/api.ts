export interface Counts {
  all: number;
  selected: number;
}

export interface Instanced {
  instance: string;
}

export interface Versioned extends Instanced {
  version: number;
  counts: Counts;
}

export interface LeftItem {
  id: number;
  custom: boolean;
}

export interface SelectedItem {
  id: number;
  key: string;
}

export interface Page<T> extends Versioned {
  items: T[];
  nextCursor: string | null;
  done: boolean;
  scanned: number;
}

export type ItemsPage = Page<LeftItem>;
export interface SelectedPage extends Page<SelectedItem> {
  epoch: number;
}

export interface AddItemResponse extends Versioned {
  item: { id: number; custom: true };
}

export interface SelectResponse extends Versioned {
  id: number;
  key: string;
  epoch: number;
  changed: boolean;
}

export interface DeselectResponse extends Versioned {
  id: number;
  changed: boolean;
}

export interface ReorderResponse extends Versioned {
  id: number;
  key: string;
  epoch: number;
  changed: boolean;
}

export type Change =
  | { v: number; type: 'added'; id: number }
  | { v: number; type: 'selected'; id: number; key: string }
  | { v: number; type: 'deselected'; id: number }
  | { v: number; type: 'moved'; id: number; key: string };

export type ChangeType = Change['type'];

export interface ChangesResponse extends Instanced {
  fromVersion: number;
  toVersion: number;
  epoch: number;
  counts: Counts;
  changes: Change[];
  hasMore: boolean;
}

export interface HealthResponse extends Instanced {
  status: 'ok' | 'shutting_down';
  uptimeSec: number;
  version: number;
  epoch: number;
  queues: { main: number; add: number };
}

export interface HelloEvent extends Instanced {
  version: number;
  epoch: number;
  counts: Counts;
  nextAddInMs: number;
}

export interface BatchEvent extends Instanced {
  fromVersion: number;
  toVersion: number;
  epoch: number;
  counts: Counts;
  changes: Change[];
}

export interface ResyncEvent extends Instanced {
  epoch: number;
  version: number;
  reason: 'rebalance' | 'history_expired' | 'version_ahead' | 'instance_changed';
}

export function formatEventId(instance: string, version: number): string {
  return `${instance}.${version}`;
}

export function parseEventId(id: string): { instance: string | null; version: number } | null {
  const m = /^(?:([A-Za-z0-9-]{1,64})\.)?(\d{1,16})$/.exec(id);
  if (!m) return null;
  return { instance: m[1] ?? null, version: Number(m[2]) };
}

export interface ShutdownEvent {
  reason: 'shutdown' | 'fatal';
}

export type ServerEvent =
  | { event: 'hello'; data: HelloEvent }
  | { event: 'batch'; data: BatchEvent }
  | { event: 'resync'; data: ResyncEvent }
  | { event: 'shutdown'; data: ShutdownEvent };
