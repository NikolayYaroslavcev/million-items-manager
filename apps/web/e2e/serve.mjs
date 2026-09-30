import { spawn } from 'node:child_process';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '../../..');
const PROXY_PORT = Number(process.env.E2E_PORT ?? 4000);
const SERVER_PORT = PROXY_PORT + 100;

let server = null;
function startServer(extraEnv = {}) {
  server = spawn(process.execPath, ['--max-old-space-size=384', 'apps/server/dist/main.js'], {
    cwd: root,
    stdio: ['ignore', 'ignore', 'inherit'],
    env: {
      ...process.env,
      NODE_ENV: 'production',
      PORT: String(SERVER_PORT),
      HOST: '127.0.0.1',
      STATIC_DIR: path.join(root, 'apps/web/dist'),
      LOG_LEVEL: 'warn',
      TRUST_PROXY: '1',
      RATE_LIMIT_ENABLED: 'false',
      SSE_MAX_PER_IP: '50',
      ...(process.env.E2E_SERVER_ENV ? JSON.parse(process.env.E2E_SERVER_ENV) : {}),
      ...extraEnv,
    },
  });
}

async function waitHealthy() {
  for (let i = 0; i < 100; i++) {
    try {
      const res = await fetch(`http://127.0.0.1:${SERVER_PORT}/api/health`);
      if (res.ok) return;
    } catch {}
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error('server did not start');
}

const streams = new Set();
const silenced = new WeakSet();
let frozen = false;

const proxy = http.createServer(async (req, res) => {
  if (req.url?.startsWith('/__proxy/')) {
    const url = new URL(req.url, 'http://proxy');
    const cmd = url.pathname.slice('/__proxy/'.length);
    if (cmd === 'freeze') {
      frozen = true;
      for (const s of streams) silenced.add(s);
    } else if (cmd === 'unfreeze') frozen = false;
    else if (cmd === 'restart') {
      for (const s of streams) s.destroy();
      await new Promise((resolve) => {
        server.once('exit', resolve);
        server.kill('SIGTERM');
      });
      startServer(JSON.parse(url.searchParams.get('env') ?? '{}'));
      await waitHealthy();
    }
    res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify({ frozen, sse: streams.size }));
    return;
  }
  const isSse = req.url?.startsWith('/api/events');
  const upstream = http.request(
    {
      host: '127.0.0.1',
      port: SERVER_PORT,
      method: req.method,
      path: req.url,
      headers: { ...req.headers, 'x-forwarded-for': req.socket.remoteAddress ?? '127.0.0.1' },
    },
    (up) => {
      res.writeHead(up.statusCode ?? 502, up.headers);
      if (!isSse || up.statusCode !== 200) {
        up.pipe(res);
        return;
      }
      res.flushHeaders();
      streams.add(res);
      if (frozen) silenced.add(res);
      const drop = () => {
        streams.delete(res);
        up.destroy();
      };
      res.on('close', drop);
      up.on('data', (chunk) => {
        if (!silenced.has(res)) res.write(chunk);
      });
      up.on('end', () => res.end());
      up.on('error', () => res.destroy());
    },
  );
  upstream.on('error', () => {
    if (!res.headersSent) res.writeHead(502);
    res.end();
  });
  req.pipe(upstream);
});

startServer();
await waitHealthy();
proxy.listen(PROXY_PORT, '127.0.0.1', () => {
  process.stdout.write(`e2e stack on http://127.0.0.1:${PROXY_PORT}\n`);
});

const stop = () => {
  server?.kill('SIGTERM');
  proxy.close();
  setTimeout(() => process.exit(0), 500);
};
process.on('SIGTERM', stop);
process.on('SIGINT', stop);
