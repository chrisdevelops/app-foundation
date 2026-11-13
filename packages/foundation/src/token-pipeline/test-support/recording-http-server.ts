// Test-only local HTTP server for gate 21 (#20; TOK-176). It counts every TCP
// connection and every request it receives, so a gate can prove that a token
// build refused a remote `$ref` before it made any request.
//
// The server runs in a worker thread with its own event loop: the gates run
// builds with `spawnSync`, which blocks the test's main thread, and a server
// on the main thread would not accept or answer while the build runs.
import { Worker } from 'node:worker_threads';

const serverWorkerSource = `
const { createServer } = require('node:http');
const { parentPort, workerData } = require('node:worker_threads');
const counts = new Int32Array(workerData.counts);
const server = createServer((request, response) => {
  Atomics.add(counts, 1, 1);
  response.writeHead(200, { 'content-type': 'application/json' });
  response.end(workerData.body);
});
server.on('connection', () => Atomics.add(counts, 0, 1));
server.listen(0, '127.0.0.1', () => parentPort.postMessage({ port: server.address().port }));
parentPort.on('message', (message) => {
  if (message !== 'close') return;
  server.closeAllConnections();
  server.close(() => parentPort.postMessage('closed'));
});
`;

export interface RecordingHttpServer {
  /** Base URL, for example `http://127.0.0.1:53124`. */
  readonly origin: string;
  /** TCP connections accepted so far. */
  connections(): number;
  /** HTTP requests received so far. */
  requests(): number;
  /** Stops the server and its worker thread. */
  close(): Promise<void>;
}

/** Starts a server on 127.0.0.1 with a free port that answers every request with `body`. */
export async function startRecordingHttpServer(body: string): Promise<RecordingHttpServer> {
  const counts = new Int32Array(new SharedArrayBuffer(2 * Int32Array.BYTES_PER_ELEMENT));
  const worker = new Worker(serverWorkerSource, { eval: true, workerData: { counts: counts.buffer, body } });
  const port = await new Promise<number>((resolve, reject) => {
    worker.once('error', reject);
    worker.once('message', (message: { port: number }) => resolve(message.port));
  });
  let closed = false;
  return {
    origin: `http://127.0.0.1:${port}`,
    connections: () => Atomics.load(counts, 0),
    requests: () => Atomics.load(counts, 1),
    async close() {
      if (closed) return;
      closed = true;
      await new Promise<void>((resolve) => {
        const timer = setTimeout(resolve, 5_000);
        worker.once('message', () => {
          clearTimeout(timer);
          resolve();
        });
        worker.postMessage('close');
      });
      await worker.terminate();
    },
  };
}
