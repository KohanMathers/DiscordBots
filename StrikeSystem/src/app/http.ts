import { createServer, type Server } from 'node:http';
import type { Logger } from 'pino';
import type { Metrics } from '../core/metrics.ts';

export function startHttpServer(opts: { port: number; metrics: Metrics; ready: () => Promise<Record<string, boolean>>; log: Logger }): Promise<Server> {
  const server = createServer(async (req, res) => {
    try {
      const path = (req.url ?? '/').split('?')[0];
      if (req.method === 'GET' && path === '/healthz') {
        res.writeHead(200, { 'content-type': 'application/json' }).end('{"status":"ok"}');
      } else if (req.method === 'GET' && path === '/readyz') {
        const checks = await opts.ready();
        const ok = Object.values(checks).every(Boolean);
        res.writeHead(ok ? 200 : 503, { 'content-type': 'application/json' }).end(JSON.stringify({ status: ok ? 'ready' : 'not ready', ...checks }));
      } else if (req.method === 'GET' && path === '/metrics') {
        res.writeHead(200, { 'content-type': 'text/plain; version=0.0.4' }).end(opts.metrics.render());
      } else {
        res.writeHead(404).end();
      }
    } catch (err) {
      opts.log.error({ err }, 'http handler failed');
      res.writeHead(500).end();
    }
  });
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(opts.port, () => {
      opts.log.info({ port: opts.port }, 'http server listening');
      resolve(server);
    });
  });
}
