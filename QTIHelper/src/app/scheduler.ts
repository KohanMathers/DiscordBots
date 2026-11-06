import type { Logger } from 'pino';

interface Loop {
  name: string;
  timer: NodeJS.Timeout | null;
  running: Promise<void> | null;
  run: () => void;
}

export class Scheduler {
  private readonly loops = new Map<string, Loop>();
  private stopped = false;
  private readonly log: Logger;

  constructor(log: Logger) {
    this.log = log;
  }

  every(name: string, intervalMs: number, task: () => Promise<unknown>, opts: { initialDelayMs?: number } = {}): void {
    const loop: Loop = { name, timer: null, running: null, run: () => undefined };
    const schedule = (delay: number) => {
      if (this.stopped) return;
      loop.timer = setTimeout(loop.run, delay);
    };
    loop.run = () => {
      if (this.stopped || loop.running) return;
      if (loop.timer) clearTimeout(loop.timer);
      loop.timer = null;
      loop.running = task()
        .then(() => undefined)
        .catch((err) => this.log.error({ err, task: name }, 'scheduled task failed'))
        .finally(() => {
          loop.running = null;
          schedule(intervalMs);
        });
    };
    this.loops.set(name, loop);
    schedule(opts.initialDelayMs ?? 0);
  }

  trigger(name: string): void {
    this.loops.get(name)?.run();
  }

  async stop(timeoutMs: number): Promise<void> {
    this.stopped = true;
    const inflight: Promise<void>[] = [];
    for (const loop of this.loops.values()) {
      if (loop.timer) clearTimeout(loop.timer);
      if (loop.running) inflight.push(loop.running);
    }
    await Promise.race([Promise.all(inflight), new Promise((r) => setTimeout(r, timeoutMs))]);
  }
}
