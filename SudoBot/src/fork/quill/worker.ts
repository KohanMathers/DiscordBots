import { parentPort, workerData } from 'node:worker_threads';
import { runQuill } from './run.ts';

const { code, setup } = workerData as { code: string; setup: string };
parentPort!.postMessage(runQuill(code, setup));
