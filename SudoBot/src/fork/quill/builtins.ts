import {
  asBool,
  asList,
  asNumber,
  asPlayer,
  asString,
  type Builtin,
  coord,
  equal,
  list,
  map,
  QuillError,
  type QValue,
  show,
  truthy,
  typeOf,
} from './runtime.ts';

const arity = (name: string, args: QValue[], ...allowed: number[]) => {
  if (!allowed.includes(args.length)) {
    const want = allowed.length === 1 ? `${allowed[0]} argument${allowed[0] === 1 ? '' : 's'}` : `${allowed.join(' or ')} arguments`;
    throw new QuillError(`${name}() requires ${want}, got ${args.length}`);
  }
};

const playerArg = (fn: string, v: QValue, position = 'first argument') => {
  if (v === null || typeof v !== 'object' || v.t !== 'player') throw new QuillError(`${fn}() expects player as ${position}, got ${typeOf(v)}`);
  return v.p;
};

const numbers = (fn: string, args: QValue[]): number[] => {
  const source = args.length === 1 && args[0] !== null && typeof args[0] === 'object' && args[0].t === 'list' ? args[0].items : args;
  if (!source.length) throw new QuillError(`${fn}() requires non-empty list`);
  return source.map((v) => asNumber(v, `${fn}()`));
};

export const UTILITY_FUNCTIONS = ['log', 'len', 'append', 'remove', 'contains', 'split', 'join', 'to_string', 'to_number', 'to_boolean', 'type_of', 'range', 'random', 'round', 'floor', 'ceil', 'abs', 'sqrt', 'pow', 'random_choice', 'min', 'max', 'sum', 'avg', 'get_player', 'get_online_players'];
export const PLAYER_FUNCTIONS = ['teleport', 'give', 'remove_item', 'set_health', 'set_hunger', 'set_gamemode', 'heal', 'kill', 'sendmessage', 'get_health', 'get_hunger', 'get_name', 'get_location', 'get_gamemode', 'set_flying', 'damage'];
export const WORLD_FUNCTIONS = ['set_block', 'get_block', 'break_block', 'set_time', 'get_time', 'set_weather', 'get_weather', 'broadcast', 'create_world', 'get_world', 'spawn_entity', 'distance'];

const GAMEMODES = ['adventure', 'creative', 'spectator', 'survival'];
const WEATHER = ['clear', 'rain', 'thunder'];
const blockKey = (x: number, y: number, z: number) => `${Math.round(x)},${Math.round(y)},${Math.round(z)}`;

export function createBuiltins(rng: () => number = Math.random): Map<string, Builtin> {
  const b = new Map<string, Builtin>();

  b.set('log', (a, it) => {
    arity('log', a, 1);
    it.sim.log(`[LOG] ${show(a[0]!)}`);
    return true;
  });
  b.set('len', (a) => {
    arity('len', a, 1);
    const v = a[0]!;
    if (typeof v === 'string') return v.length;
    if (v !== null && typeof v === 'object' && v.t === 'list') return v.items.length;
    if (v !== null && typeof v === 'object' && v.t === 'map') return v.entries.size;
    throw new QuillError(`len() expects list, string, or map, got ${typeOf(v)}`);
  });
  b.set('append', (a, it) => {
    arity('append', a, 2);
    const items = asList(a[0]!, 'append() first argument');
    items.push(a[1]!);
    it.checkList(items);
    return true;
  });
  b.set('remove', (a) => {
    arity('remove', a, 2);
    const items = asList(a[0]!, 'remove() first argument');
    const i = Math.trunc(asNumber(a[1]!, 'remove() second argument'));
    if (i < 0 || i >= items.length) throw new QuillError(`Index ${i} out of bounds for list of size ${items.length}`);
    items.splice(i, 1);
    return true;
  });
  b.set('contains', (a) => {
    arity('contains', a, 2);
    const [c, x] = a as [QValue, QValue];
    if (typeof c === 'string') return c.includes(asString(x, 'contains() second argument'));
    if (c !== null && typeof c === 'object' && c.t === 'list') return c.items.some((v) => equal(v, x));
    throw new QuillError(`contains() expects list or string, got ${typeOf(c)}`);
  });
  b.set('split', (a) => {
    arity('split', a, 2);
    const parts = asString(a[0]!, 'split()').split(asString(a[1]!, 'split()'));
    while (parts.length > 1 && parts.at(-1) === '') parts.pop();
    return list(parts);
  });
  b.set('join', (a, it) => {
    arity('join', a, 2);
    return it.checkString(asList(a[0]!, 'join()').map(show).join(asString(a[1]!, 'join()')));
  });
  b.set('to_string', (a) => {
    arity('to_string', a, 1);
    return show(a[0]!);
  });
  b.set('to_number', (a) => {
    arity('to_number', a, 1);
    const v = a[0]!;
    if (typeof v === 'number') return v;
    if (typeof v === 'boolean') return v ? 1 : 0;
    if (typeof v === 'string') {
      const n = Number(v.trim());
      if (v.trim() === '' || Number.isNaN(n)) throw new QuillError(`Cannot convert string '${v}' to number`);
      return n;
    }
    throw new QuillError(`Cannot convert ${typeOf(v)} to number`);
  });
  b.set('to_boolean', (a) => {
    arity('to_boolean', a, 1);
    return truthy(a[0]!);
  });
  b.set('type_of', (a) => {
    arity('type_of', a, 1);
    return typeOf(a[0]!);
  });
  b.set('range', (a, it) => {
    arity('range', a, 2);
    const start = Math.trunc(asNumber(a[0]!, 'range()'));
    const end = Math.trunc(asNumber(a[1]!, 'range()'));
    const out: QValue[] = [];
    const step = start <= end ? 1 : -1;
    for (let i = start; step > 0 ? i < end : i > end; i += step) {
      out.push(i);
      if (out.length > 100_000) it.checkList(out);
    }
    return list(out);
  });
  b.set('random', (a) => {
    arity('random', a, 1, 2);
    const [min, max] = a.length === 1 ? [0, asNumber(a[0]!, 'random()')] : [asNumber(a[0]!, 'random()'), asNumber(a[1]!, 'random()')];
    return rng() * (max - min) + min;
  });
  b.set('round', (a) => (arity('round', a, 1), Math.round(asNumber(a[0]!, 'round()'))));
  b.set('floor', (a) => (arity('floor', a, 1), Math.floor(asNumber(a[0]!, 'floor()'))));
  b.set('ceil', (a) => (arity('ceil', a, 1), Math.ceil(asNumber(a[0]!, 'ceil()'))));
  b.set('abs', (a) => (arity('abs', a, 1), Math.abs(asNumber(a[0]!, 'abs()'))));
  b.set('sqrt', (a) => (arity('sqrt', a, 1), Math.sqrt(asNumber(a[0]!, 'sqrt()'))));
  b.set('pow', (a) => (arity('pow', a, 2), asNumber(a[0]!, 'pow()') ** asNumber(a[1]!, 'pow()')));
  b.set('random_choice', (a) => {
    arity('random_choice', a, 1);
    const items = asList(a[0]!, 'random_choice()');
    if (!items.length) throw new QuillError('random_choice() requires non-empty list');
    return items[Math.floor(rng() * items.length)]!;
  });
  b.set('min', (a) => {
    if (!a.length) throw new QuillError('min() requires at least 1 argument');
    return Math.min(...numbers('min', a));
  });
  b.set('max', (a) => {
    if (!a.length) throw new QuillError('max() requires at least 1 argument');
    return Math.max(...numbers('max', a));
  });
  b.set('sum', (a) => {
    arity('sum', a, 1);
    if (a[0] === null || typeof a[0] !== 'object' || a[0].t !== 'list') throw new QuillError(`sum() expects list, got ${typeOf(a[0]!)}`);
    return a[0].items.reduce<number>((s, v) => s + asNumber(v, 'sum()'), 0);
  });
  b.set('avg', (a) => {
    arity('avg', a, 1);
    const items = asList(a[0]!, 'avg()');
    if (!items.length) throw new QuillError('avg() requires non-empty list');
    return items.reduce<number>((s, v) => s + asNumber(v, 'avg()'), 0) / items.length;
  });
  b.set('get_player', (a, it) => {
    arity('get_player', a, 1);
    return { t: 'player', p: it.sim.player(asString(a[0]!, 'get_player()')) };
  });
  b.set('get_online_players', (a, it) => {
    arity('get_online_players', a, 0);
    return list([...it.sim.players.values()].map((p) => ({ t: 'player' as const, p })));
  });

  b.set('teleport', (a, it) => {
    arity('teleport', a, 2, 4);
    const p = playerArg('teleport', a[0]!);
    let x: number, y: number, z: number;
    if (a.length === 2) {
      const loc = a[1]!;
      if (loc === null || typeof loc !== 'object' || loc.t !== 'map') throw new QuillError(`teleport() expects a location map {x, y, z} as second argument, got ${typeOf(loc)}`);
      [x, y, z] = ['x', 'y', 'z'].map((k) => asNumber(loc.entries.get(k) ?? null, `teleport() location ${k}`)) as [number, number, number];
    } else {
      [x, y, z] = a.slice(1).map((v) => asNumber(v, 'teleport()')) as [number, number, number];
    }
    Object.assign(p, { x, y, z });
    it.sim.log(`[TELEPORT] ${p.name} teleported to (${coord(x)}, ${coord(y)}, ${coord(z)})`);
    return true;
  });
  b.set('give', (a, it) => {
    arity('give', a, 2, 3);
    const p = playerArg('give', a[0]!);
    const item = asString(a[1]!, 'give() item');
    const amount = a.length === 3 ? Math.trunc(asNumber(a[2]!, 'give() amount')) : 1;
    p.inventory.set(item, (p.inventory.get(item) ?? 0) + amount);
    it.sim.log(`[GIVE] ${p.name} received ${amount}x ${item}`);
    return true;
  });
  b.set('remove_item', (a, it) => {
    arity('remove_item', a, 2, 3);
    const p = playerArg('remove_item', a[0]!);
    const item = asString(a[1]!, 'remove_item() item');
    const amount = a.length === 3 ? Math.trunc(asNumber(a[2]!, 'remove_item() amount')) : 1;
    const have = p.inventory.get(item) ?? 0;
    if (have > amount) p.inventory.set(item, have - amount);
    else p.inventory.delete(item);
    it.sim.log(`[REMOVE_ITEM] ${p.name} lost ${amount}x ${item}`);
    return amount;
  });
  b.set('set_health', (a, it) => {
    arity('set_health', a, 2);
    const p = playerArg('set_health', a[0]!);
    const h = asNumber(a[1]!, 'set_health()');
    if (h < 0 || h > 20) throw new QuillError(`set_health() expects health between 0 and 20, got ${coord(h)}`);
    p.health = Math.min(h, p.maxHealth);
    it.sim.log(`[HEALTH] ${p.name} health set to ${coord(h)}`);
    return true;
  });
  b.set('set_hunger', (a, it) => {
    arity('set_hunger', a, 2);
    const p = playerArg('set_hunger', a[0]!);
    const h = Math.trunc(asNumber(a[1]!, 'set_hunger()'));
    if (h < 0 || h > 20) throw new QuillError(`set_hunger() expects hunger between 0 and 20, got ${h}`);
    p.hunger = h;
    it.sim.log(`[HUNGER] ${p.name} hunger set to ${h}`);
    return true;
  });
  b.set('set_gamemode', (a, it) => {
    arity('set_gamemode', a, 2);
    const p = playerArg('set_gamemode', a[0]!);
    const mode = asString(a[1]!, 'set_gamemode()').toLowerCase();
    if (!GAMEMODES.includes(mode)) throw new QuillError(`set_gamemode() expects one of [${GAMEMODES.join(', ')}], got ${mode}`);
    p.gamemode = mode;
    it.sim.log(`[GAMEMODE] ${p.name} gamemode set to ${mode}`);
    return true;
  });
  b.set('heal', (a, it) => {
    arity('heal', a, 1);
    const p = playerArg('heal', a[0]!, 'argument');
    p.health = p.maxHealth;
    it.sim.log(`[HEAL] ${p.name} healed to full health`);
    return true;
  });
  b.set('kill', (a, it) => {
    arity('kill', a, 1);
    const p = playerArg('kill', a[0]!, 'argument');
    p.health = 0;
    it.sim.log(`[KILL] ${p.name} was killed`);
    return true;
  });
  b.set('sendmessage', (a, it) => {
    arity('sendmessage', a, 2);
    const p = playerArg('sendmessage', a[0]!);
    it.sim.message(p.name, asString(a[1]!, 'sendmessage() message'));
    return true;
  });
  b.set('get_health', (a) => (arity('get_health', a, 1), playerArg('get_health', a[0]!, 'argument').health));
  b.set('get_hunger', (a) => (arity('get_hunger', a, 1), playerArg('get_hunger', a[0]!, 'argument').hunger));
  b.set('get_name', (a) => (arity('get_name', a, 1), playerArg('get_name', a[0]!, 'argument').name));
  b.set('get_gamemode', (a) => (arity('get_gamemode', a, 1), playerArg('get_gamemode', a[0]!, 'argument').gamemode));
  b.set('get_location', (a) => {
    arity('get_location', a, 1);
    const p = playerArg('get_location', a[0]!, 'argument');
    return map({ x: p.x, y: p.y, z: p.z });
  });
  b.set('set_flying', (a, it) => {
    arity('set_flying', a, 2);
    const p = playerArg('set_flying', a[0]!);
    p.flying = asBool(a[1]!, 'set_flying()');
    it.sim.log(`[FLYING] ${p.name} flying set to ${p.flying}`);
    return true;
  });
  b.set('damage', (a, it) => {
    arity('damage', a, 2);
    const p = playerArg('damage', a[0]!);
    const d = asNumber(a[1]!, 'damage()');
    p.health = Math.max(0, Math.min(p.health - d, p.maxHealth));
    it.sim.log(`[DAMAGE] ${p.name} took ${coord(d)} damage`);
    return true;
  });

  const xyz = (fn: string, a: QValue[], from = 0) => a.slice(from, from + 3).map((v) => asNumber(v, `${fn}()`)) as [number, number, number];
  b.set('set_block', (a, it) => {
    arity('set_block', a, 4);
    const [x, y, z] = xyz('set_block', a);
    const type = asString(a[3]!, 'set_block() block type');
    it.sim.world().blocks.set(blockKey(x, y, z), type);
    it.sim.log(`[BLOCK] Set block at (${coord(x)}, ${coord(y)}, ${coord(z)}) to ${type}`);
    return true;
  });
  b.set('get_block', (a, it) => {
    arity('get_block', a, 3);
    const [x, y, z] = xyz('get_block', a);
    return it.sim.world().blocks.get(blockKey(x, y, z)) ?? 'air';
  });
  b.set('break_block', (a, it) => {
    arity('break_block', a, 3);
    const [x, y, z] = xyz('break_block', a);
    it.sim.world().blocks.set(blockKey(x, y, z), 'air');
    it.sim.log(`[BREAK] Broke block at (${coord(x)}, ${coord(y)}, ${coord(z)})`);
    return true;
  });
  b.set('set_time', (a, it) => {
    arity('set_time', a, 1);
    const t = Math.trunc(asNumber(a[0]!, 'set_time()'));
    if (t < 0 || t > 24000) throw new QuillError(`set_time() expects time between 0 and 24000, got ${t}`);
    it.sim.world().time = t % 24000;
    it.sim.log(`[TIME] World time set to ${t}`);
    return true;
  });
  b.set('get_time', (a, it) => (arity('get_time', a, 0), it.sim.world().time));
  b.set('set_weather', (a, it) => {
    arity('set_weather', a, 1);
    const w = asString(a[0]!, 'set_weather()').toLowerCase();
    if (!WEATHER.includes(w)) throw new QuillError(`set_weather() expects one of [${WEATHER.join(', ')}], got ${w}`);
    it.sim.world().weather = w;
    it.sim.log(`[WEATHER] Weather set to ${w}`);
    return true;
  });
  b.set('get_weather', (a, it) => (arity('get_weather', a, 0), it.sim.world().weather));
  b.set('broadcast', (a, it) => {
    arity('broadcast', a, 1);
    const msg = asString(a[0]!, 'broadcast()');
    it.sim.log(`[BROADCAST] ${msg}`);
    for (const p of it.sim.players.values()) it.sim.message(p.name, msg);
    return true;
  });
  b.set('create_world', (a, it) => {
    arity('create_world', a, 1);
    return { t: 'world', w: it.sim.createWorld(asString(a[0]!, 'create_world()')) };
  });
  b.set('get_world', (a, it) => {
    arity('get_world', a, 0, 1);
    return { t: 'world', w: it.sim.world(a.length ? asString(a[0]!, 'get_world()') : 'world') };
  });
  b.set('spawn_entity', (a, it) => {
    arity('spawn_entity', a, 4);
    const type = asString(a[0]!, 'spawn_entity() entity type');
    const [x, y, z] = xyz('spawn_entity', a, 1);
    it.sim.world().entities.push({ type, x, y, z });
    it.sim.log(`[ENTITY] Spawned ${type} at (${coord(x)}, ${coord(y)}, ${coord(z)})`);
    return map({ type, x, y, z });
  });
  b.set('distance', (a) => {
    arity('distance', a, 2);
    const p1 = asPlayer(a[0]!, 'distance()');
    const p2 = asPlayer(a[1]!, 'distance()');
    return Math.hypot(p1.x - p2.x, p1.y - p2.y, p1.z - p2.z);
  });

  return b;
}
