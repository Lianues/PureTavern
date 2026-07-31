import process from 'node:process';

import { createRemoteServer, readSettings } from './app.mjs';

const settings = readSettings();
const server = createRemoteServer(settings);
server.requestTimeout = 120_000;
server.headersTimeout = 30_000;
server.keepAliveTimeout = 5_000;

await new Promise((resolve, reject) => {
  server.once('error', reject);
  server.listen(settings.port, settings.host, () => {
    server.off('error', reject);
    resolve();
  });
});

const address = server.address();
const port = address && typeof address === 'object' ? address.port : settings.port;
console.log(`PureTavern Node.js remote server listening on http://${settings.host}:${port}`);

let shuttingDown = false;
for (const signal of ['SIGINT', 'SIGTERM']) {
  process.once(signal, () => {
    if (shuttingDown) return;
    shuttingDown = true;
    console.log(`Received ${signal}; closing the remote server.`);
    const forceTimer = setTimeout(() => server.closeAllConnections(), 10_000);
    forceTimer.unref();
    server.close((error) => {
      clearTimeout(forceTimer);
      if (error) {
        console.error('Failed to close the remote server cleanly.');
        process.exitCode = 1;
      }
    });
  });
}
