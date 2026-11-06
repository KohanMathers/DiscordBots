import { Worker } from 'node:worker_threads';
import type { RunResult } from './run.ts';

const HARD_TIMEOUT_MS = 8_000;
const MAX_CONCURRENT = 2;
let running = 0;
const waiting: Array<() => void> = [];

const failure = (message: string): RunResult => ({
  ok: false,
  error: { kind: 'limit', message },
  logs: [],
  droppedLogs: 0,
  messages: [],
  players: [],
  worlds: [],
  setupCount: { players: 0, events: 0 },
});

export async function runInSandbox(code: string, setup: string, timeoutMs = HARD_TIMEOUT_MS): Promise<RunResult> {
  if (running >= MAX_CONCURRENT) await new Promise<void>((r) => waiting.push(r));
  running++;
  try {
    return await new Promise<RunResult>((resolve) => {
      const worker = new Worker(new URL('./worker.ts', import.meta.url), {
        workerData: { code, setup },
        resourceLimits: { maxOldGenerationSizeMb: 64, maxYoungGenerationSizeMb: 16, stackSizeMb: 4 },
      });
      const timer = setTimeout(() => {
        void worker.terminate();
        resolve(failure(`The script ran longer than ${timeoutMs / 1000} seconds and was stopped`));
      }, timeoutMs);
      worker.once('message', (r: RunResult) => {
        clearTimeout(timer);
        resolve(r);
        void worker.terminate();
      });
      worker.once('error', (err: Error & { code?: string }) => {
        clearTimeout(timer);
        resolve(failure(err.code === 'ERR_WORKER_OUT_OF_MEMORY' ? 'The script used too much memory and was stopped' : `The simulator crashed: ${err.message}`));
      });
    });
  } finally {
    running--;
    waiting.shift()?.();
  }
}
