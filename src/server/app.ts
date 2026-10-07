import { createServer, type IncomingMessage } from 'node:http';
import { readFile } from 'node:fs/promises';
import { resolve, extname, sep } from 'node:path';
import { WebSocketServer, WebSocket } from 'ws';
import { z } from 'zod';
import type { Runtime, Session, Publish } from '../runtime/runtime.js';

const clientMessage = z.discriminatedUnion('type', [
  z.strictObject({ type: z.literal('chat'), text: z.string().trim().min(1).max(2000) }),
  z.strictObject({ type: z.literal('session.reset') }),
]);
const localHosts = new Set(['localhost', '127.0.0.1', '[::1]']);

function allowedRequest(request: IncomingMessage): boolean {
  try {
    const host = request.headers.host;
    if (!host || !localHosts.has(new URL(`http://${host}`).hostname)) return false;
    const origin = request.headers.origin;
    // Non-browser clients have no Origin. Browsers must be same-origin.
    return !origin || origin === `http://${host}`;
  } catch {
    return false;
  }
}

export function createApp(runtime: Runtime, uiDirectory = resolve('dist/ui')) {
  const active = new Set<Promise<void>>();
  let stopping = false;
  const server = createServer(async (request, response) => {
    response.setHeader('X-Content-Type-Options', 'nosniff');
    response.setHeader(
      'Content-Security-Policy',
      "default-src 'self'; script-src 'self'; style-src 'self'; connect-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'",
    );
    response.setHeader('Cache-Control', 'no-store');
    if (!allowedRequest(request)) {
      response.writeHead(403).end();
      return;
    }
    if (request.method !== 'GET') {
      response.writeHead(405).end();
      return;
    }
    if (request.url === '/health') {
      response.setHeader('Content-Type', 'application/json');
      response.end(JSON.stringify({ status: 'ok', provider: runtime.provider.name }));
      return;
    }
    try {
      const pathname = decodeURIComponent(new URL(request.url ?? '/', 'http://localhost').pathname);
      const file = resolve(uiDirectory, `.${pathname === '/' ? '/index.html' : pathname}`);
      if (!file.startsWith(`${resolve(uiDirectory)}${sep}`)) {
        response.writeHead(403).end();
        return;
      }
      const body = await readFile(file);
      const mime: Record<string, string> = {
        '.html': 'text/html',
        '.js': 'text/javascript',
        '.css': 'text/css',
        '.svg': 'image/svg+xml',
      };
      response.setHeader('Content-Type', mime[extname(file)] ?? 'application/octet-stream');
      response.end(body);
    } catch {
      response.writeHead(404).end('Build the UI with pnpm build, or use pnpm dev.');
    }
  });

  const sockets = new WebSocketServer({
    noServer: true,
    maxPayload: 8192,
    perMessageDeflate: false,
  });
  server.on('upgrade', (request, socket, head) => {
    if (
      stopping ||
      request.url !== '/ws' ||
      !allowedRequest(request) ||
      sockets.clients.size >= 32
    ) {
      socket.end('HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n');
      return;
    }
    sockets.handleUpgrade(request, socket, head, (ws) => sockets.emit('connection', ws));
  });
  sockets.on('connection', (ws) => {
    let session: Session;
    const publish: Publish = (packet) => {
      if (ws.readyState !== WebSocket.OPEN) return;
      if (ws.bufferedAmount > 65536) {
        ws.close(1013, 'Slow client');
        return;
      }
      ws.send(JSON.stringify(packet));
    };
    try {
      session = runtime.start(publish);
    } catch {
      ws.close(1011, 'Runtime unavailable');
      return;
    }
    let windowStarted = Date.now();
    let messageCount = 0;
    ws.on('error', () => {
      /* protocol failures are handled by ws; never log raw frames */
    });
    ws.on('message', (data, isBinary) => {
      if (stopping) return;
      if (Date.now() - windowStarted >= 10000) {
        windowStarted = Date.now();
        messageCount = 0;
      }
      if (++messageCount > 20) {
        ws.close(1008, 'Message rate exceeded');
        return;
      }
      try {
        if (isBinary) {
          runtime.reject(session, 'INVALID_MESSAGE', publish);
          return;
        }
        let input: unknown;
        try {
          input = JSON.parse(data.toString());
        } catch {
          runtime.reject(session, 'INVALID_MESSAGE', publish);
          return;
        }
        const parsed = clientMessage.safeParse(input);
        if (!parsed.success) {
          runtime.reject(session, 'INVALID_MESSAGE', publish);
          return;
        }
        if (parsed.data.type === 'session.reset') {
          if (session.busy) runtime.reject(session, 'BUSY', publish);
          else session = runtime.start(publish);
          return;
        }
        const task = runtime.chat(session, parsed.data.text, publish);
        active.add(task);
        void task
          .catch(() => ws.close(1011, 'Runtime unavailable'))
          .finally(() => active.delete(task));
      } catch {
        ws.close(1008, 'Invalid request');
      }
    });
  });

  // Remove dead clients without retaining application sessions in a global map.
  const alive = new WeakSet<WebSocket>();
  sockets.on('connection', (ws) => {
    alive.add(ws);
    ws.on('pong', () => alive.add(ws));
  });
  const heartbeat = setInterval(() => {
    for (const ws of sockets.clients) {
      if (!alive.has(ws)) {
        ws.terminate();
        continue;
      }
      alive.delete(ws);
      ws.ping();
    }
  }, 30000);
  heartbeat.unref();

  return {
    server,
    async close(): Promise<void> {
      stopping = true;
      clearInterval(heartbeat);
      for (const ws of sockets.clients) ws.terminate();
      await Promise.allSettled([...active]);
      await new Promise<void>((done) => sockets.close(() => done()));
      if (server.listening)
        await new Promise<void>((done, reject) =>
          server.close((error) => (error ? reject(error) : done())),
        );
    },
  };
}
