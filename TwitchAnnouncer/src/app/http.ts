import { createServer, type Server } from 'node:http';
import type { Logger } from 'pino';
import type { Metrics } from '../core/metrics.ts';

export function startHttpServer(opts: {
  port: number;
  metrics: Metrics;
  isHealthy: () => Promise<{ ok: boolean; detail: Record<string, unknown> }>;
  log: Logger;
}): Promise<Server> {
  const server = createServer(async (req, res) => {
    try {
      const path = (req.url ?? '/').split('?')[0];
      if (req.method === 'GET' && path === '/healthz') {
        const h = await opts.isHealthy();
        res.writeHead(h.ok ? 200 : 503, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ status: h.ok ? 'ok' : 'unhealthy', ...h.detail }));
        return;
      }
      if (req.method === 'GET' && path === '/metrics') {
        res.writeHead(200, { 'content-type': 'text/plain; version=0.0.4' });
        res.end(opts.metrics.render());
        return;
      }
      res.writeHead(404).end();
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
