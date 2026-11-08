/** Serves the page to the browser. Reachable only from this machine, and only with the secret in the path. */
import { createReadStream, statSync } from 'node:fs';
import { timingSafeEqual } from 'node:crypto';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { WEB_ASSETS } from 'virtual:web-assets';
import type { HandAssets } from './hand-assets.ts';
import { parseLegend } from './legend.ts';
import type { LegendGroup } from '../../src/types.ts';

const HAND_PREFIXES = ['mediapipe/', 'models/'];
const CONTENT_TYPES: Record<string, string> = {
  js: 'text/javascript; charset=utf-8',
  wasm: 'application/wasm',
  task: 'application/octet-stream',
};

const MAX_LEGEND_BYTES = 16 * 1024;

export interface GraphProvider {
  (): string | null;
}

export interface LegendStore {
  read(): LegendGroup[] | null;
  write(legend: LegendGroup[]): Promise<void>;
}

function sameSecret(a: string, b: string): boolean {
  const left = Buffer.from(a);
  const right = Buffer.from(b);
  return left.length === right.length && timingSafeEqual(left, right);
}

function baseHeaders(): Record<string, string> {
  return {
    // The secret is in the URL, so it must never leak through a Referer header.
    'Referrer-Policy': 'no-referrer',
    'X-Content-Type-Options': 'nosniff',
    'Cache-Control': 'no-store',
  };
}

export class LocalServer {
  private server: Server | null = null;
  private readonly port: number;
  private readonly token: string;
  private readonly graph: GraphProvider;
  private readonly hands: HandAssets;
  private readonly legend: LegendStore;

  constructor(port: number, token: string, graph: GraphProvider, hands: HandAssets, legend: LegendStore) {
    this.port = port;
    this.token = token;
    this.graph = graph;
    this.hands = hands;
    this.legend = legend;
  }

  get url(): string {
    return `http://127.0.0.1:${this.port}/${this.token}/`;
  }

  get running(): boolean {
    return this.server !== null;
  }

  start(): Promise<void> {
    return new Promise((resolve, reject) => {
      const server = createServer((req, res) => this.handle(req, res));
      server.once('error', reject);
      server.listen(this.port, '127.0.0.1', () => {
        server.removeListener('error', reject);
        this.server = server;
        resolve();
      });
    });
  }

  stop(): void {
    this.server?.close();
    this.server?.closeAllConnections();
    this.server = null;
  }

  private send(res: ServerResponse, status: number, type: string, body: string | Buffer): void {
    res.writeHead(status, { ...baseHeaders(), 'Content-Type': type });
    res.end(body);
  }

  private handle(req: IncomingMessage, res: ServerResponse): void {
    // A wrong Host means DNS rebinding: a remote site reaching this port through its own name.
    if (req.headers.host !== `127.0.0.1:${this.port}`) {
      this.send(res, 403, 'text/plain', 'Forbidden');
      return;
    }
    const pathname = new URL(req.url ?? '/', 'http://127.0.0.1').pathname;
    const [, secret = '', ...rest] = pathname.split('/');
    if (!sameSecret(secret, this.token)) {
      this.send(res, 404, 'text/plain', 'Not found');
      return;
    }
    if (rest.length === 0) {
      res.writeHead(302, { ...baseHeaders(), Location: `/${this.token}/` });
      res.end();
      return;
    }
    const path = decodeURIComponent(rest.join('/'));

    if (path === 'api/hand-assets') {
      if (req.method === 'POST') {
        if (!this.fromPage(req)) {
          this.send(res, 403, 'text/plain', 'Forbidden');
          return;
        }
        this.hands.download();
      }
      this.send(res, 200, 'application/json', JSON.stringify(this.hands.getStatus()));
      return;
    }
    if (path === 'api/legend' && req.method === 'POST') {
      if (this.fromPage(req)) void this.saveLegend(req, res);
      else this.send(res, 403, 'text/plain', 'Forbidden');
      return;
    }
    if (req.method !== 'GET' && req.method !== 'HEAD') {
      this.send(res, 405, 'text/plain', 'Method not allowed');
      return;
    }
    if (path === 'api/legend') {
      this.send(res, 200, 'application/json', JSON.stringify(this.legend.read()));
      return;
    }
    if (path === 'data/graph.json') {
      const graph = this.graph();
      if (graph) this.send(res, 200, 'application/json; charset=utf-8', graph);
      else this.send(res, 503, 'text/plain', 'Graph not ready');
      return;
    }
    if (HAND_PREFIXES.some((p) => path.startsWith(p))) {
      this.sendHandFile(res, path);
      return;
    }
    const asset = WEB_ASSETS[path === '' ? 'index.html' : path];
    if (!asset) {
      this.send(res, 404, 'text/plain', 'Not found');
      return;
    }
    this.send(res, 200, asset.type, Buffer.from(asset.data, 'base64'));
  }

  private fromPage(req: IncomingMessage): boolean {
    return req.headers.origin === `http://127.0.0.1:${this.port}`;
  }

  private async saveLegend(req: IncomingMessage, res: ServerResponse): Promise<void> {
    try {
      const chunks: Buffer[] = [];
      let size = 0;
      for await (const chunk of req as AsyncIterable<Buffer>) {
        size += chunk.length;
        if (size > MAX_LEGEND_BYTES) {
          this.send(res, 413, 'text/plain', 'Too large');
          return;
        }
        chunks.push(chunk);
      }
      const legend = parseLegend(JSON.parse(Buffer.concat(chunks).toString('utf8')));
      if (!legend) {
        this.send(res, 400, 'text/plain', 'Invalid legend');
        return;
      }
      await this.legend.write(legend);
      this.send(res, 200, 'application/json', 'true');
    } catch {
      this.send(res, 400, 'text/plain', 'Invalid legend');
    }
  }

  private sendHandFile(res: ServerResponse, path: string): void {
    const file = this.hands.resolve(path);
    if (!file) {
      this.send(res, 404, 'text/plain', 'Not found');
      return;
    }
    res.writeHead(200, {
      ...baseHeaders(),
      'Content-Type': CONTENT_TYPES[path.split('.').pop() ?? ''] ?? 'application/octet-stream',
      'Content-Length': statSync(file).size,
    });
    createReadStream(file).pipe(res);
  }
}
