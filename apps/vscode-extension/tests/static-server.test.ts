import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { PackagedWebServer, resolveStaticPath } from '../src/static-server.js';

const roots: string[] = [];
const servers: PackagedWebServer[] = [];

afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => server.stop()));
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function createFixture() {
  const root = await mkdtemp(path.join(tmpdir(), 'pure-tavern-vscode-server-'));
  roots.push(root);
  await mkdir(path.join(root, 'scripts'), { recursive: true });
  await writeFile(
    path.join(root, 'index.html'),
    '<!doctype html><html><head><script src="/__pure_tavern/legacy-hook.js"></script></head><body><h1>PureTavern</h1></body></html>',
    'utf8',
  );
  await writeFile(path.join(root, 'scripts', 'app.js'), 'export const ready = true;', 'utf8');
  return root;
}

describe('PackagedWebServer', () => {
  it('serves the packaged root and JavaScript with safe MIME headers', async () => {
    const root = await createFixture();
    const server = new PackagedWebServer(root);
    servers.push(server);
    const port = await server.start();

    const index = await fetch(`http://127.0.0.1:${port}/`);
    expect(index.status).toBe(200);
    expect(index.headers.get('content-type')).toBe('text/html; charset=utf-8');
    const indexHtml = await index.text();
    expect(indexHtml).toContain('PureTavern');
    expect(indexHtml.match(/data-pure-tavern-vscode-local-backend="1"/gu)).toHaveLength(1);
    expect(indexHtml).toContain('src="__pure_tavern/vscode-local-backend.js"');
    expect(indexHtml).not.toContain('src="/__pure_tavern/vscode-local-backend.js"');
    expect(indexHtml.indexOf('vscode-local-backend.js')).toBeLessThan(
      indexHtml.indexOf('legacy-hook.js'),
    );

    const bridge = await fetch(`http://127.0.0.1:${port}/__pure_tavern/vscode-local-backend.js`);
    expect(bridge.headers.get('cache-control')).toBe('no-store');
    expect(await bridge.text()).toContain("protocol: 'pure-tavern-local-backend'");

    const script = await fetch(`http://127.0.0.1:${port}/scripts/app.js`);
    expect(script.headers.get('content-type')).toBe('application/javascript; charset=utf-8');
    expect(script.headers.get('service-worker-allowed')).toBe('/');
  });

  it('rejects traversal and does not expose files outside the packaged root', async () => {
    const root = await createFixture();
    expect(resolveStaticPath(root, '/%2e%2e%2fsecret.txt')).toBeNull();
    expect(resolveStaticPath(root, '/scripts/app.js')).toBe(path.join(root, 'scripts', 'app.js'));
  });

  it('reuses one listener and shuts down cleanly', async () => {
    const root = await createFixture();
    const server = new PackagedWebServer(root);
    servers.push(server);
    const first = await server.start();
    await expect(server.start()).resolves.toBe(first);
    await server.stop();
    servers.splice(servers.indexOf(server), 1);
    await expect(fetch(`http://127.0.0.1:${first}/`)).rejects.toThrow();
  });
});
