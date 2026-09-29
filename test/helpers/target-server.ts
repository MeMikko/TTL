import http from 'node:http';
import type { AddressInfo } from 'node:net';

export interface Received {
  method: string;
  url: string;
  headers: http.IncomingHttpHeaders;
  body: string;
}

export type Handler = (req: Received, res: http.ServerResponse) => unknown;

/** Local HTTP server that records requests; the handler decides the response. */
export async function startTargetServer(handler: Handler = (_r, res) => res.end('ok')) {
  const received: Received[] = [];
  let current = handler;
  const server = http.createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => chunks.push(c));
    req.on('end', () => {
      const r = {
        method: req.method ?? '',
        url: req.url ?? '',
        headers: req.headers,
        body: Buffer.concat(chunks).toString('utf8'),
      };
      received.push(r);
      void current(r, res);
    });
  });
  await new Promise<void>((ok) => server.listen(0, '127.0.0.1', ok));
  const { port } = server.address() as AddressInfo;
  return {
    port,
    url: (path = '/') => `http://127.0.0.1:${port}${path}`,
    received,
    setHandler(h: Handler) {
      current = h;
    },
    close: () =>
      new Promise<void>((ok) => {
        server.closeAllConnections();
        server.close(() => ok());
      }),
  };
}
