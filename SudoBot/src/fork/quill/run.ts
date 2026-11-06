import { createBuiltins } from './builtins.ts';
import { LexerError, tokenize } from './lexer.ts';
import { ParseError, parse } from './parser.ts';
import { DEFAULT_LIMITS, Interpreter, LimitError, type Limits, map, QuillError, type QValue, Simulation } from './runtime.ts';

export interface RunResult {
  ok: boolean;
  error?: { kind: 'lexer' | 'parser' | 'runtime' | 'limit' | 'setup'; message: string };
  logs: string[];
  droppedLogs: number;
  messages: string[];
  players: Array<{ name: string; health: number; x: number; y: number; z: number; gamemode: string }>;
  worlds: Array<{ name: string; time: number; weather: string }>;
  setupCount: { players: number; events: number };
}

const NUM = String.raw`(-?\d+(?:\.\d+)?)`;
const PLAYER_LINE = new RegExp(String.raw`PLAYER\s+(\w+)\s+AT\s+${NUM}\s+${NUM}\s+${NUM}`, 'gi');
const EVENT_LINE = /^\s*EVENT\s+(\w+)(?:\s+(\w+))?\s*$/gim;

export interface Setup {
  players: Array<{ name: string; x: number; y: number; z: number }>;
  events: Array<{ name: string; player: string | null }>;
}

export function parseSetup(text: string): Setup {
  return {
    players: [...text.matchAll(PLAYER_LINE)].map((m) => ({ name: m[1]!, x: Number(m[2]), y: Number(m[3]), z: Number(m[4]) })),
    events: [...text.matchAll(EVENT_LINE)].map((m) => ({ name: m[1]!, player: m[2] ?? null })),
  };
}

export function extractCode(content: string): { code: string | null; rest: string } {
  const blocks = [...content.matchAll(/```(?:quill)?[ \t]*\n?([\s\S]*?)```/g)];
  return { code: blocks.length ? blocks.at(-1)![1]!.trim() : null, rest: content.replace(/```[\s\S]*?```/g, '\n') };
}

export function runQuill(code: string, setupText: string, limits: Limits = DEFAULT_LIMITS, rng?: () => number): RunResult {
  const sim = new Simulation(limits.maxLogs);
  const setup = parseSetup(setupText);
  const snapshot = (error?: RunResult['error']): RunResult => ({
    ok: !error,
    ...(error ? { error } : {}),
    logs: sim.logs,
    droppedLogs: sim.droppedLogs,
    messages: sim.messages,
    players: [...sim.players.values()].map((p) => ({ name: p.name, health: p.health, x: p.x, y: p.y, z: p.z, gamemode: p.gamemode })),
    worlds: [...sim.worlds.values()].map((w) => ({ name: w.name, time: w.time, weather: w.weather })),
    setupCount: { players: setup.players.length, events: setup.events.length },
  });

  try {
    for (const p of setup.players) sim.spawnPlayer(p.name, p.x, p.y, p.z);
  } catch (err) {
    return snapshot({ kind: 'setup', message: (err as Error).message });
  }

  let interpreter: Interpreter;
  try {
    const program = parse(tokenize(code));
    interpreter = new Interpreter(sim, createBuiltins(rng), limits);
    interpreter.run(program);
    let n = 0;
    for (const ev of setup.events) {
      if (++n > limits.eventIterations) {
        sim.log(`[WARNING] Event processing stopped after ${limits.eventIterations} iterations`);
        break;
      }
      const context: Record<string, QValue> = { event: map({ name: ev.name, player: ev.player }) };
      if (ev.player) {
        const p = sim.players.get(ev.player);
        if (p) context.player = { t: 'player', p };
        else sim.log(`[WARNING] EVENT ${ev.name}: player '${ev.player}' wasn't spawned with a PLAYER line`);
      }
      interpreter.trigger(ev.name, context);
    }
  } catch (err) {
    if (err instanceof LexerError) return snapshot({ kind: 'lexer', message: err.message });
    if (err instanceof ParseError) return snapshot({ kind: 'parser', message: err.message });
    if (err instanceof LimitError) return snapshot({ kind: 'limit', message: err.message });
    if (err instanceof QuillError) return snapshot({ kind: 'runtime', message: err.message });
    if (err instanceof RangeError) return snapshot({ kind: 'limit', message: 'The script recursed too deeply' });
    if (err && typeof err === 'object' && 'constructor' in err) {
      const n = (err as object).constructor.name;
      if (n === 'ReturnSignal') return snapshot();
      if (n === 'BreakSignal' || n === 'ContinueSignal') return snapshot({ kind: 'runtime', message: `'${n === 'BreakSignal' ? 'break' : 'continue'}' used outside a loop` });
    }
    throw err;
  }
  return snapshot();
}
