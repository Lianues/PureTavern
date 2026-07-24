import { createReadStream } from 'node:fs';
import { stat } from 'node:fs/promises';
import { createServer, type Server, type ServerResponse } from 'node:http';
import path from 'node:path';

const MIME_TYPES: Readonly<Record<string, string>> = Object.freeze({
  '.css': 'text/css; charset=utf-8',
  '.gif': 'image/gif',
  '.html': 'text/html; charset=utf-8',
  '.ico': 'image/x-icon',
  '.jpeg': 'image/jpeg',
  '.jpg': 'image/jpeg',
  '.js': 'application/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.map': 'application/json; charset=utf-8',
  '.mjs': 'application/javascript; charset=utf-8',
  '.mp3': 'audio/mpeg',
  '.mp4': 'video/mp4',
  '.ogg': 'audio/ogg',
  '.otf': 'font/otf',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
  '.ttf': 'font/ttf',
  '.txt': 'text/plain; charset=utf-8',
  '.wasm': 'application/wasm',
  '.webm': 'video/webm',
  '.webp': 'image/webp',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
});

export function resolveStaticPath(root: string, requestPath: string): string | null {
  let decoded: string;
  try {
    decoded = decodeURIComponent(requestPath);
  } catch {
    return null;
  }
  const relative = decoded.replace(/^\/+/, '') || 'index.html';
  const target = path.resolve(root, relative.endsWith('/') ? `${relative}index.html` : relative);
  const normalizedRoot = path.resolve(root);
  if (target !== normalizedRoot && !target.startsWith(`${normalizedRoot}${path.sep}`)) return null;
  return target;
}

function applyHeaders(response: ServerResponse, contentType: string, size: number) {
  response.setHeader('Content-Type', contentType);
  response.setHeader('Content-Length', String(size));
  response.setHeader('Cache-Control', 'no-cache');
  response.setHeader('X-Content-Type-Options', 'nosniff');
  if (contentType.startsWith('application/javascript')) {
    response.setHeader('Service-Worker-Allowed', '/');
  }
}

export class PackagedWebServer {
  readonly #root: string;
  #server: Server | undefined;
  #port: number | undefined;

  constructor(root: string) {
    this.#root = path.resolve(root);
  }

  get port(): number {
    if (!this.#port) throw new Error('PureTavern packaged web server is not running.');
    return this.#port;
  }

  async start(): Promise<number> {
    if (this.#server) return this.port;
    const server = createServer((request, response) => {
      void this.#handle(request.method ?? 'GET', request.url ?? '/', response);
    });
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject);
      server.listen(0, '127.0.0.1', () => resolve());
    });
    const address = server.address();
    if (!address || typeof address === 'string') {
      server.close();
      throw new Error('PureTavern packaged web server did not receive a TCP port.');
    }
    this.#server = server;
    this.#port = address.port;
    return address.port;
  }

  async stop(): Promise<void> {
    const server = this.#server;
    this.#server = undefined;
    this.#port = undefined;
    if (!server) return;
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }

  async #handle(method: string, requestUrl: string, response: ServerResponse) {
    if (method !== 'GET' && method !== 'HEAD') {
      response.writeHead(405, { Allow: 'GET, HEAD' });
      response.end();
      return;
    }
    let pathname: string;
    try {
      pathname = new URL(requestUrl, 'http://localhost').pathname;
    } catch {
      response.writeHead(400);
      response.end();
      return;
    }
    const target = resolveStaticPath(this.#root, pathname);
    if (!target) {
      response.writeHead(403);
      response.end();
      return;
    }
    try {
      const info = await stat(target);
      if (!info.isFile()) throw new Error('Not a file');
      applyHeaders(
        response,
        MIME_TYPES[path.extname(target).toLowerCase()] ?? 'application/octet-stream',
        info.size,
      );
      response.writeHead(200);
      if (method === 'HEAD') {
        response.end();
        return;
      }
      const stream = createReadStream(target);
      stream.once('error', () => {
        if (!response.headersSent) response.writeHead(500);
        response.end();
      });
      stream.pipe(response);
    } catch {
      response.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
      response.end('Not found');
    }
  }
}
