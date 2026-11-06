import type { Expr, Program, Stmt } from './ast.ts';

export interface MockPlayer {
  name: string;
  x: number;
  y: number;
  z: number;
  health: number;
  maxHealth: number;
  hunger: number;
  gamemode: string;
  flying: boolean;
  inventory: Map<string, number>;
}

export interface MockWorld {
  name: string;
  time: number;
  weather: string;
  blocks: Map<string, string>;
  entities: Array<{ type: string; x: number; y: number; z: number }>;
}

export type QList = { t: 'list'; items: QValue[] };
export type QMap = { t: 'map'; entries: Map<string, QValue> };
export type QFunc = { t: 'func'; name: string; params: string[]; body: Stmt[] };
export type QPlayer = { t: 'player'; p: MockPlayer };
export type QWorld = { t: 'world'; w: MockWorld };
export type QScope = { t: 'scope'; scope: Scope };
export type QValue = number | string | boolean | null | QList | QMap | QFunc | QPlayer | QWorld | QScope;

export const list = (items: QValue[]): QList => ({ t: 'list', items });
export const map = (o: Record<string, QValue> = {}): QMap => ({ t: 'map', entries: new Map(Object.entries(o)) });

export function typeOf(v: QValue): string {
  if (v === null) return 'null';
  if (typeof v === 'object') return v.t === 'func' ? 'function' : v.t;
  return typeof v;
}

export const numText = (n: number) => String(n);
export const coord = (n: number) => (Number.isInteger(n) ? n.toFixed(1) : String(n));

export function show(v: QValue): string {
  if (v === null) return 'null';
  if (typeof v === 'number') return numText(v);
  if (typeof v === 'string') return v;
  if (typeof v === 'boolean') return String(v);
  switch (v.t) {
    case 'list':
      return `[${v.items.map(show).join(', ')}]`;
    case 'map':
      return `{${[...v.entries].map(([k, x]) => `${k}: ${show(x)}`).join(', ')}}`;
    case 'func':
      return `Function(${v.name})`;
    case 'player':
      return `Player(${v.p.name})`;
    case 'world':
      return `World(${v.w.name})`;
    case 'scope':
      return `Scope(${v.scope.name})`;
  }
}

export function truthy(v: QValue): boolean {
  if (v === null) return false;
  if (typeof v === 'boolean') return v;
  if (typeof v === 'number') return v !== 0;
  if (typeof v === 'string') return v.length > 0;
  if (v.t === 'list') return v.items.length > 0;
  return true;
}

export function equal(a: QValue, b: QValue): boolean {
  if (a === null || b === null) return a === b;
  if (typeOf(a) !== typeOf(b)) return false;
  if (typeof a !== 'object') return a === b;
  if (a.t === 'player' && typeof b === 'object' && b !== null && b.t === 'player') return a.p === b.p;
  if (a.t === 'world' && typeof b === 'object' && b !== null && b.t === 'world') return a.w === b.w;
  return a === b;
}

export class QuillError extends Error {
  override name = 'QuillError';
}
export class LimitError extends Error {
  override name = 'LimitError';
}

const expectType = (fn: string, v: QValue, want: string): never => {
  throw new QuillError(`${fn} expected ${want} but got ${typeOf(v)}`);
};
export const asNumber = (v: QValue, fn = 'Operation'): number => (typeof v === 'number' ? v : expectType(fn, v, 'number'));
export const asString = (v: QValue, fn = 'Operation'): string => (typeof v === 'string' ? v : expectType(fn, v, 'string'));
export const asBool = (v: QValue, fn = 'Operation'): boolean => (typeof v === 'boolean' ? v : expectType(fn, v, 'boolean'));
export const asList = (v: QValue, fn = 'Operation'): QValue[] => (v !== null && typeof v === 'object' && v.t === 'list' ? v.items : expectType(fn, v, 'list'));
export const asPlayer = (v: QValue, fn = 'Operation'): MockPlayer => (v !== null && typeof v === 'object' && v.t === 'player' ? v.p : expectType(fn, v, 'player'));

export class Scope {
  readonly name: string;
  readonly parent: Scope | null;
  private readonly vars = new Map<string, QValue>();
  private readonly consts = new Set<string>();

  constructor(name: string, parent: Scope | null) {
    this.name = name;
    this.parent = parent;
  }

  define(name: string, value: QValue, isConst = false): void {
    if (this.vars.has(name)) throw new QuillError(`Variable '${name}' already defined in this scope`);
    this.vars.set(name, value);
    if (isConst) this.consts.add(name);
  }

  private owner(name: string): Scope | null {
    let s: Scope | null = this;
    while (s && !s.vars.has(name)) s = s.parent;
    return s;
  }

  set(name: string, value: QValue): void {
    const s = this.owner(name) ?? this;
    if (s.consts.has(name)) throw new QuillError(`Cannot reassign constant variable '${name}'`);
    s.vars.set(name, value);
  }

  get(name: string): QValue {
    const s = this.owner(name);
    if (!s) throw new QuillError(`Undefined variable: '${name}'`);
    return s.vars.get(name)!;
  }
}

export interface Limits {
  loopIterations: number;
  timeMs: number;
  steps: number;
  callDepth: number;
  maxString: number;
  maxList: number;
  maxLogs: number;
  eventIterations: number;
}

export const DEFAULT_LIMITS: Limits = {
  loopIterations: 10_000,
  timeMs: 5_000,
  steps: 2_000_000,
  callDepth: 200,
  maxString: 100_000,
  maxList: 100_000,
  maxLogs: 1_000,
  eventIterations: 100,
};

export class Simulation {
  readonly players = new Map<string, MockPlayer>();
  readonly worlds = new Map<string, MockWorld>();
  readonly logs: string[] = [];
  readonly messages: string[] = [];
  readonly events: Array<{ name: string; player: string | null }> = [];
  droppedLogs = 0;
  private readonly maxLogs: number;

  constructor(maxLogs = DEFAULT_LIMITS.maxLogs) {
    this.maxLogs = maxLogs;
    this.worlds.set('world', newWorld('world'));
  }

  log(line: string): void {
    if (this.logs.length < this.maxLogs) this.logs.push(line);
    else this.droppedLogs++;
  }

  spawnPlayer(name: string, x: number, y: number, z: number): MockPlayer {
    if (this.players.has(name)) throw new QuillError(`Player '${name}' already exists`);
    const p: MockPlayer = { name, x, y, z, health: 20, maxHealth: 20, hunger: 20, gamemode: 'survival', flying: false, inventory: new Map() };
    this.players.set(name, p);
    this.log(`[SPAWN] Player '${name}' spawned at (${coord(x)}, ${coord(y)}, ${coord(z)})`);
    return p;
  }

  player(name: string): MockPlayer {
    const p = this.players.get(name);
    if (!p) throw new QuillError(`Player '${name}' not found`);
    return p;
  }

  world(name = 'world'): MockWorld {
    const w = this.worlds.get(name);
    if (!w) throw new QuillError(`World '${name}' not found`);
    return w;
  }

  createWorld(name: string): MockWorld {
    if (this.worlds.has(name)) throw new QuillError(`World '${name}' already exists`);
    const w = newWorld(name);
    this.worlds.set(name, w);
    this.log(`[WORLD] Created world '${name}'`);
    return w;
  }

  message(player: string, text: string): void {
    this.messages.push(`${player}: ${text}`);
    this.log(`[MSG] ${player}: ${text}`);
  }
}

const newWorld = (name: string): MockWorld => ({ name, time: 0, weather: 'clear', blocks: new Map(), entities: [] });

export type Builtin = (args: QValue[], it: Interpreter) => QValue;

class ReturnSignal {
  readonly value: QValue;
  constructor(value: QValue) {
    this.value = value;
  }
}
class BreakSignal {}
class ContinueSignal {}

export class Interpreter {
  readonly sim: Simulation;
  readonly global = new Scope('global', null);
  private scope: Scope = this.global;
  private readonly builtins: Map<string, Builtin>;
  private readonly handlers = new Map<string, Stmt[][]>();
  private readonly limits: Limits;
  private readonly deadline: number;
  private steps = 0;
  private depth = 0;

  constructor(sim: Simulation, builtins: Map<string, Builtin>, limits: Limits = DEFAULT_LIMITS, now = Date.now()) {
    this.sim = sim;
    this.builtins = builtins;
    this.limits = limits;
    this.deadline = now + limits.timeMs;
  }

  private tick(): void {
    if (++this.steps > this.limits.steps) throw new LimitError(`Script exceeded ${this.limits.steps.toLocaleString('en-GB')} steps`);
    if ((this.steps & 1023) === 0 && Date.now() > this.deadline) throw new LimitError(`Script exceeded ${this.limits.timeMs / 1000} seconds`);
  }

  checkString(s: string): string {
    if (s.length > this.limits.maxString) throw new LimitError(`A string grew past ${this.limits.maxString.toLocaleString('en-GB')} characters`);
    return s;
  }

  checkList(items: QValue[]): void {
    if (items.length > this.limits.maxList) throw new LimitError(`A list grew past ${this.limits.maxList.toLocaleString('en-GB')} items`);
  }

  run(program: Program): void {
    for (const s of program.body) this.exec(s);
  }

  get eventNames(): string[] {
    return [...this.handlers.keys()];
  }

  trigger(name: string, context: Record<string, QValue>): void {
    const list = this.handlers.get(name);
    if (!list?.length) {
      this.sim.log(`[EVENT] No handler for event: ${name}`);
      return;
    }
    this.sim.log(`[TRIGGER] Event: ${name}`);
    for (const body of list) {
      const prev = this.scope;
      this.scope = new Scope(`event_${name}`, this.global);
      for (const [k, v] of Object.entries(context)) this.scope.define(k, v);
      try {
        this.block(body);
      } catch (err) {
        if (err instanceof LimitError) throw err;
        if (err instanceof QuillError) this.sim.log(`[ERROR] Error in event handler ${name}: ${err.message}`);
        else if (!(err instanceof ReturnSignal)) throw err;
      } finally {
        this.scope = prev;
      }
    }
  }

  private block(stmts: Stmt[]): void {
    for (const s of stmts) this.exec(s);
  }

  private inScope<T>(name: string, fn: () => T): T {
    const prev = this.scope;
    this.scope = new Scope(name, prev);
    try {
      return fn();
    } finally {
      this.scope = prev;
    }
  }

  private exec(s: Stmt): void {
    this.tick();
    switch (s.kind) {
      case 'Expr':
        this.eval(s.expr);
        return;
      case 'Let':
        this.scope.define(s.name, this.eval(s.value), s.isConst);
        return;
      case 'Func':
        this.scope.define(s.name, { t: 'func', name: s.name, params: s.params, body: s.body });
        return;
      case 'Return':
        throw new ReturnSignal(s.value ? this.eval(s.value) : null);
      case 'Break':
        throw new BreakSignal();
      case 'Continue':
        throw new ContinueSignal();
      case 'If':
        if (truthy(this.eval(s.condition))) this.block(s.then);
        else if (s.else) this.block(s.else);
        return;
      case 'While': {
        let n = 0;
        while (truthy(this.eval(s.condition))) {
          if (++n > this.limits.loopIterations) {
            throw new QuillError(`Infinite loop detected: Loop exceeded maximum iterations (${this.limits.loopIterations}). Possible infinite loop detected.`);
          }
          try {
            this.inScope('while_iteration', () => this.block(s.body));
          } catch (e) {
            if (e instanceof BreakSignal) break;
            if (e instanceof ContinueSignal) continue;
            throw e;
          }
        }
        return;
      }
      case 'For': {
        const iterable = this.eval(s.iterable);
        if (iterable === null || typeof iterable !== 'object' || iterable.t !== 'list') throw new QuillError(`For loop expects a list, got ${typeOf(iterable)}`);
        let n = 0;
        for (const item of [...iterable.items]) {
          if (++n > this.limits.loopIterations) {
            throw new QuillError(`Infinite loop detected: Loop exceeded maximum iterations (${this.limits.loopIterations}). Possible infinite loop detected.`);
          }
          try {
            this.inScope('for_iteration', () => {
              this.scope.define(s.variable, item);
              this.block(s.body);
            });
          } catch (e) {
            if (e instanceof BreakSignal) break;
            if (e instanceof ContinueSignal) continue;
            throw e;
          }
        }
        return;
      }
      case 'Try':
        try {
          this.inScope('try', () => this.block(s.body));
        } catch (e) {
          if (!(e instanceof QuillError)) throw e;
          this.inScope('try_catch', () => {
            this.scope.define(s.errorVar, e.message);
            this.block(s.handler);
          });
        }
        return;
      case 'OnEvent': {
        const list = this.handlers.get(s.event) ?? [];
        list.push(s.body);
        this.handlers.set(s.event, list);
        this.sim.log(`[EVENT] Registered handler for event: ${s.event}`);
        return;
      }
    }
  }

  eval(e: Expr): QValue {
    this.tick();
    switch (e.kind) {
      case 'Number':
        return e.value;
      case 'String':
        return e.value;
      case 'Boolean':
        return e.value;
      case 'Null':
        return null;
      case 'List': {
        const items = e.elements.map((x) => this.eval(x));
        this.checkList(items);
        return list(items);
      }
      case 'Map':
        return { t: 'map', entries: new Map(e.entries.map((x) => [x.key, this.eval(x.value)])) };
      case 'Identifier':
        return this.scope.get(e.name);
      case 'Member': {
        const obj = this.eval(e.object);
        if (obj !== null && typeof obj === 'object' && obj.t === 'scope') return obj.scope.get(e.property);
        if (obj !== null && typeof obj === 'object' && obj.t === 'map') return obj.entries.get(e.property) ?? null;
        throw new QuillError(`Cannot access property '${e.property}' on type ${typeOf(obj)}`);
      }
      case 'Index': {
        const obj = this.eval(e.object);
        const idx = this.eval(e.index);
        if (obj !== null && typeof obj === 'object' && obj.t === 'map') return obj.entries.get(asString(idx, 'Map index')) ?? null;
        if (obj !== null && typeof obj === 'object' && obj.t === 'list') {
          const i = Math.trunc(asNumber(idx, 'List index'));
          if (i < 0 || i >= obj.items.length) throw new QuillError(`Index ${i} out of bounds for list of size ${obj.items.length}`);
          return obj.items[i]!;
        }
        throw new QuillError(`Cannot index type ${typeOf(obj)}`);
      }
      case 'Unary': {
        const v = this.eval(e.operand);
        if (e.op === '!') return !truthy(v);
        return -asNumber(v, 'Unary minus');
      }
      case 'Binary':
        return this.binary(e.op, this.eval(e.left), this.eval(e.right));
      case 'Assign':
        return this.assign(e.target, this.eval(e.value));
      case 'Call':
        return this.call(e);
      case 'NewScope': {
        if (e.args.length !== 6) throw new QuillError('Scope creation requires 6 boundary arguments (x1, y1, z1, x2, y2, z2)');
        e.args.forEach((a) => asNumber(this.eval(a), 'Scope bounds'));
        return { t: 'scope', scope: new Scope('subscope', this.scope) };
      }
    }
  }

  private binary(op: string, l: QValue, r: QValue): QValue {
    switch (op) {
      case '+':
        if (typeof l === 'number' && typeof r === 'number') return l + r;
        return this.checkString(show(l) + show(r));
      case '-':
        return asNumber(l) - asNumber(r);
      case '*':
        return asNumber(l) * asNumber(r);
      case '/':
        if (asNumber(r) === 0) throw new QuillError('Division by zero');
        return asNumber(l) / asNumber(r);
      case '%':
        return asNumber(l) % asNumber(r);
      case '==':
        return equal(l, r);
      case '!=':
        return !equal(l, r);
      case '>':
        return asNumber(l) > asNumber(r);
      case '<':
        return asNumber(l) < asNumber(r);
      case '>=':
        return asNumber(l) >= asNumber(r);
      case '<=':
        return asNumber(l) <= asNumber(r);
      case '&&':
        return truthy(l) && truthy(r);
      case '||':
        return truthy(l) || truthy(r);
      default:
        throw new QuillError(`Unknown binary operator: ${op}`);
    }
  }

  private assign(target: Expr, value: QValue): QValue {
    if (target.kind === 'Identifier') {
      this.scope.set(target.name, value);
      return value;
    }
    if (target.kind === 'Member') {
      const obj = this.eval(target.object);
      if (obj !== null && typeof obj === 'object' && obj.t === 'scope') obj.scope.set(target.property, value);
      else if (obj !== null && typeof obj === 'object' && obj.t === 'map') obj.entries.set(target.property, value);
      else throw new QuillError(`Cannot assign to member of type ${typeOf(obj)}`);
      return value;
    }
    if (target.kind === 'Index') {
      const obj = this.eval(target.object);
      const idx = this.eval(target.index);
      if (obj !== null && typeof obj === 'object' && obj.t === 'map') obj.entries.set(asString(idx, 'Map index'), value);
      else if (obj !== null && typeof obj === 'object' && obj.t === 'list') {
        const i = Math.trunc(asNumber(idx, 'List index'));
        if (i < 0 || i >= obj.items.length) throw new QuillError(`Index ${i} out of bounds`);
        obj.items[i] = value;
      } else throw new QuillError(`Cannot index type ${typeOf(obj)}`);
      return value;
    }
    throw new QuillError('Invalid assignment target');
  }

  private call(e: Extract<Expr, { kind: 'Call' }>): QValue {
    if (e.callee.kind === 'Identifier') {
      const builtin = this.builtins.get(e.callee.name);
      if (builtin) return builtin(e.args.map((a) => this.eval(a)), this);
    }
    const callee = this.eval(e.callee);
    const args = e.args.map((a) => this.eval(a));
    if (callee === null || typeof callee !== 'object' || callee.t !== 'func') throw new QuillError(`Cannot call type ${typeOf(callee)}`);
    if (args.length !== callee.params.length) {
      throw new QuillError(`Function ${callee.name} expects ${callee.params.length} arguments, got ${args.length}`);
    }
    if (++this.depth > this.limits.callDepth) {
      this.depth = 0;
      throw new LimitError(`Maximum call depth (${this.limits.callDepth}) exceeded: is there runaway recursion?`);
    }
    const prev = this.scope;
    this.scope = new Scope(`function_${callee.name}`, prev);
    try {
      callee.params.forEach((p, i) => this.scope.define(p, args[i]!));
      this.block(callee.body);
      return null;
    } catch (err) {
      if (err instanceof ReturnSignal) return err.value;
      throw err;
    } finally {
      this.scope = prev;
      this.depth--;
    }
  }
}
