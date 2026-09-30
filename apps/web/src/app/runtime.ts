import { toast } from 'sonner';
import { Api } from '../api/http.js';
import { SyncEngine, type Notice } from '../sync/engine.js';
import { TabHub } from '../sync/tabs.js';
import { EventTransport } from '../sync/transport.js';

function showNotice(notice: Notice): void {
  const options = {
    ...(notice.id ? { id: notice.id } : {}),
    ...(notice.action
      ? { action: { label: notice.action.label, onClick: notice.action.run } }
      : {}),
  };
  if (notice.kind === 'error') toast.error(notice.message, { ...options, duration: 8000 });
  else if (notice.kind === 'success') toast.success(notice.message, options);
  else toast(notice.message, options);
}

export const api = new Api();
export const engine = new SyncEngine({ api, notify: showNotice });

let transport: EventTransport | null = null;
export const hub = new TabHub({
  sink: engine.receive,
  createTransport: (emit) => {
    transport = new EventTransport({
      api,
      getPosition: () =>
        engine.version !== null && engine.instance !== null
          ? { instance: engine.instance, version: engine.version }
          : null,
      emit,
    });
    return transport;
  },
  describe: () => engine.describe(),
  onLeaderChange: (isLeader) => engine.setLeader(isLeader),
});

export function startApp(): void {
  engine.start();
  hub.start();
  window.addEventListener('pagehide', () => hub.stop());
  (window as unknown as { __mim: unknown }).__mim = {
    get version() {
      return engine.version;
    },
    get instance() {
      return engine.instance;
    },
    get isLeader() {
      return hub.isLeader;
    },
    get connection() {
      return engine.connection;
    },
    get stats() {
      return { engine: engine.stats, transport: transport?.stats ?? null };
    },
    get ops() {
      return engine.ops.length;
    },
    debugRightIds: () => engine.right.mirror.items.map((item) => item.id),
  };
}
