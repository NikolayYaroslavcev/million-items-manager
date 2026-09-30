import type { Clock } from '../../src/core/clock.js';

interface Timer {
  id: number;
  at: number;
  fn: () => void;
}

export class FakeClock implements Clock {
  private time = 0;
  private seq = 0;
  private timers: Timer[] = [];

  now(): number {
    return this.time;
  }

  setTimeout(fn: () => void, ms: number): unknown {
    const timer = { id: ++this.seq, at: this.time + Math.max(0, ms), fn };
    this.timers.push(timer);
    return timer.id;
  }

  clearTimeout(handle: unknown): void {
    this.timers = this.timers.filter((t) => t.id !== handle);
  }

  yield(): Promise<void> {
    return Promise.resolve();
  }

  async advance(ms: number): Promise<void> {
    const target = this.time + ms;
    for (;;) {
      await flush();
      const due = this.timers
        .filter((t) => t.at <= target)
        .sort((a, b) => a.at - b.at || a.id - b.id)[0];
      if (!due) break;
      this.timers = this.timers.filter((t) => t !== due);
      this.time = Math.max(this.time, due.at);
      due.fn();
    }
    this.time = Math.max(this.time, target);
    await flush();
  }

  bump(ms: number): void {
    this.time += ms;
  }

  runNextTimer(): void {
    const due = [...this.timers].sort((a, b) => a.at - b.at || a.id - b.id)[0];
    if (!due) throw new Error('no timers');
    this.timers = this.timers.filter((t) => t !== due);
    this.time = Math.max(this.time, due.at);
    due.fn();
  }

  async advanceTo(at: number): Promise<void> {
    await this.advance(Math.max(0, at - this.time));
  }
}

export async function flush(): Promise<void> {
  for (let i = 0; i < 5; i++) await new Promise<void>((r) => setImmediate(r));
}
