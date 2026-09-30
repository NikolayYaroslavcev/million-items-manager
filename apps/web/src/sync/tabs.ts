import type { ConnectionStatus, JournalMessage } from './transport.js';

export const LEADER_LOCK = 'mim-events-leader';
export const CHANNEL_NAME = 'mim-events';

type HubMessage = JournalMessage | { t: 'who' };

export interface Leadership {
  start(): void;
  stop(): void;
}

export interface TabHubDeps {
  sink(message: JournalMessage): void;
  createTransport(emit: (message: JournalMessage) => void): Leadership;
  describe(): { hello: JournalMessage | null; status: ConnectionStatus | null };
  onLeaderChange?(isLeader: boolean): void;
  locks?: LockManager | null;
  channelFactory?: ((name: string) => BroadcastChannel) | null;
}

export class TabHub {
  private channel: BroadcastChannel | null = null;
  private transport: Leadership | null = null;
  private release: (() => void) | null = null;
  private stopped = false;
  isLeader = false;

  constructor(private readonly deps: TabHubDeps) {}

  start(): void {
    const locks =
      this.deps.locks !== undefined
        ? this.deps.locks
        : typeof navigator !== 'undefined'
          ? (navigator.locks ?? null)
          : null;
    const channelFactory =
      this.deps.channelFactory !== undefined
        ? this.deps.channelFactory
        : typeof BroadcastChannel !== 'undefined'
          ? (name: string) => new BroadcastChannel(name)
          : null;
    if (!locks || !channelFactory) {
      this.becomeLeader();
      return;
    }
    this.channel = channelFactory(CHANNEL_NAME);
    this.channel.onmessage = (event: MessageEvent<HubMessage>) => this.onChannel(event.data);
    locks
      .request(LEADER_LOCK, () => {
        if (this.stopped) return undefined;
        this.becomeLeader();
        return new Promise<void>((resolve) => (this.release = resolve));
      })
      .catch(() => {
        if (!this.stopped && !this.isLeader) this.becomeLeader();
      });
    this.channel.postMessage({ t: 'who' } satisfies HubMessage);
  }

  stop(): void {
    this.stopped = true;
    this.transport?.stop();
    this.transport = null;
    this.release?.();
    this.release = null;
    this.channel?.close();
    this.channel = null;
  }

  private becomeLeader(): void {
    this.isLeader = true;
    this.deps.onLeaderChange?.(true);
    this.transport = this.deps.createTransport((message) => {
      this.deps.sink(message);
      this.channel?.postMessage(message);
    });
    this.transport.start();
  }

  private onChannel(message: HubMessage): void {
    if (this.stopped) return;
    if (message.t === 'who') {
      if (!this.isLeader) return;
      const { hello, status } = this.deps.describe();
      if (hello) this.channel?.postMessage(hello);
      if (status) this.channel?.postMessage({ t: 'status', data: status } satisfies HubMessage);
      return;
    }
    if (!this.isLeader) this.deps.sink(message);
  }
}
