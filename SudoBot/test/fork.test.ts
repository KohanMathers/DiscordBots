import { readFileSync } from 'node:fs';
import { parse as parseYaml } from 'yaml';
import { describe, expect, it } from 'vitest';
import { parseVersionOutput, versionEmbed } from '../src/fork/detect/version.ts';
import { extractYaml, MAX_FIELDS, yamlOverview } from '../src/fork/detect/yaml.ts';
import { docsEmbed, fetchDocPage, findDocPath, htmlToSections } from '../src/fork/quill/docs.ts';
import { LexerError, tokenize } from '../src/fork/quill/lexer.ts';
import { ParseError, parse } from '../src/fork/quill/parser.ts';
import { fenced, helpEmbed, resultEmbed } from '../src/fork/quill/render.ts';
import { extractCode, parseSetup, runQuill } from '../src/fork/quill/run.ts';
import { runInSandbox } from '../src/fork/quill/sandbox.ts';
import { configEmbed, linksEmbed, verEmbed } from '../src/fork/support/texts.ts';

const logs = (code: string, setup = '') => {
  const r = runQuill(code, setup);
  if (!r.ok) throw new Error(`${r.error!.kind}: ${r.error!.message}`);
  return r.logs.filter((l) => l.startsWith('[LOG]')).map((l) => l.slice(6));
};
const fails = (code: string, setup = '') => runQuill(code, setup).error;

describe('Quill lexer and parser', () => {
  it('tokenizes and skips comments', () => {
    const t = tokenize('let x = 5 // hi\n/* block */ log("a\\nb")');
    expect(t.map((x) => x.type)).toEqual(['Let', 'Identifier', '=', 'Number', 'Identifier', '(', 'String', ')', 'EOF']);
    expect(t[6]!.value).toBe('a\nb');
  });
  it('reports lexer errors', () => {
    expect(() => tokenize('let s = "oops\n"')).toThrow(LexerError);
    expect(() => tokenize('let a = 1 # 2')).toThrow(/Unrecognised character/);
    expect(() => tokenize('/* never closed')).toThrow(/Unterminated multi-line comment/);
  });
  it('respects precedence', () => {
    expect(logs('log(1 + 2 * 3)\nlog((1 + 2) * 3)\nlog(10 - 4 - 3)\nlog(!false && 2 > 1)')).toEqual(['7', '9', '3', 'true']);
  });
  it('reads x-1 as subtraction (old simulator bug)', () => {
    expect(logs('let x = 5\nlet y = x-1\nlog(y)\nlog(-x)')).toEqual(['4', '-5']);
  });
  it('reports parser errors with line numbers', () => {
    expect(() => parse(tokenize('if x > 1 {\n log(1)'))).toThrow(ParseError);
    expect(() => parse(tokenize('let = 5'))).toThrow(/Expected a variable name, but found "=" on line 1/);
  });
});

describe('Quill language', () => {
  it('variables, const and scoping', () => {
    expect(logs('let a = 1\nconst B = 2\na = a + B\nlog(a)')).toEqual(['3']);
    expect(fails('const B = 2\nB = 3')?.message).toBe("Cannot reassign constant variable 'B'");
    expect(fails('log(nope)')?.message).toBe("Undefined variable: 'nope'");
    expect(fails('let a = 1\nlet a = 2')?.message).toBe("Variable 'a' already defined in this scope");
  });
  it('functions, return and recursion', () => {
    expect(logs('func fib(n) { if n < 2 { return n } return fib(n - 1) + fib(n - 2) }\nlog(fib(15))')).toEqual(['610']);
    expect(fails('func f(a) { return a }\nf(1, 2)')?.message).toBe('Function f expects 1 arguments, got 2');
  });
  it('if / else if / while / for / break / continue', () => {
    const code = `
      let out = []
      for i in range(0, 10) {
        if i == 2 { continue }
        if i == 6 { break }
        append(out, i)
      }
      log(out)
      let n = 0
      while n < 3 { n = n + 1 }
      if n > 5 { log("big") } else if n == 3 { log("three") } else { log("small") }`;
    expect(logs(code)).toEqual(['[0, 1, 3, 4, 5]', 'three']);
  });
  it('lists and maps, member and index access', () => {
    expect(logs('let m = {name: "Steve", "hp": 20}\nm.level = 3\nm["hp"] = m.hp - 5\nlog(m.name)\nlog(m["hp"])\nlog(len(m))\nlet l = [1, 2, 3]\nl[1] = 9\nlog(l)\nlog(l[2])')).toEqual(['Steve', '15', '3', '[1, 9, 3]', '3']);
    expect(fails('let l = [1]\nlog(l[5])')?.message).toBe('Index 5 out of bounds for list of size 1');
  });
  it('try / catch catches script errors', () => {
    expect(logs('try { log(1 / 0) } catch err { log("caught: " + err) }')).toEqual(['caught: Division by zero']);
  });
  it('scopes from new Scope(...)', () => {
    expect(logs('let s = new Scope(0, 0, 0, 10, 10, 10)\ns.points = 5\nlog(s.points)\nlog(type_of(s))')).toEqual(['5', 'scope']);
    expect(fails('let s = new Scope(1, 2)')?.message).toMatch(/requires 6 boundary arguments/);
  });
  it('stops runaway loops and recursion, which try cannot swallow', () => {
    expect(fails('while true { let a = 1 }')?.message).toMatch(/Loop exceeded maximum iterations \(10000\)/);
    expect(fails('for i in range(0, 200) { for j in range(0, 200) { for k in range(0, 200) { let a = 1 } } }')?.kind).toBe('limit');
    expect(fails('func f() { try { f() } catch e { log(e) } }\nf()')?.kind).toBe('limit');
  });
  it('let inside a while body works on every iteration', () => {
    expect(logs('let n = 0\nwhile n < 3 { let sq = n * n\n log(sq)\n n = n + 1 }')).toEqual(['0', '1', '4']);
  });
  it('nested loops each keep their own guard (old simulator bug)', () => {
    const r = runQuill('for i in range(0, 3) { for j in range(0, 2) { } }\nlet n = 0\nwhile true { n = n + 1 }', '');
    expect(r.error?.message).toMatch(/Loop exceeded maximum iterations/);
  });
});

describe('Quill simulation', () => {
  it('spawns PLAYER lines (case-insensitive, negatives) and simulates players and worlds', () => {
    const setup = 'player Steve AT 0 64 0\nPLAYER Alex at -10.5 70 3';
    const code = `
      let s = get_player("Steve")
      let a = get_player("Alex")
      teleport(s, 10, 64, 10)
      teleport(a, get_location(s))
      damage(s, 5)
      give(s, "diamond", 3)
      set_gamemode(a, "creative")
      broadcast("hello")
      set_time(6000)
      set_weather("rain")
      log(distance(s, a))
      log(len(get_online_players()))
      log(spawn_entity("zombie", 1, 2, 3).type)`;
    const r = runQuill(code, setup);
    expect(r.ok).toBe(true);
    expect(r.logs).toContain("[SPAWN] Player 'Alex' spawned at (-10.5, 70.0, 3.0)");
    expect(r.logs).toContain('[LOG] 0');
    expect(r.logs).toContain('[LOG] zombie');
    expect(r.messages).toEqual(['Steve: hello', 'Alex: hello']);
    expect(r.players.find((p) => p.name === 'Steve')).toMatchObject({ health: 15, x: 10 });
    expect(r.players.find((p) => p.name === 'Alex')).toMatchObject({ x: 10, gamemode: 'creative' });
    expect(r.worlds[0]).toMatchObject({ time: 6000, weather: 'rain' });
  });
  it('runs OnEvent handlers for EVENT lines, logging handler errors', () => {
    const code = 'OnEvent(player_join) { sendmessage(player, "welcome " + event.name) }\nOnEvent(boom) { log(1 / 0) }';
    const r = runQuill(code, 'PLAYER Steve AT 0 64 0\nEVENT player_join Steve\nEVENT boom\nEVENT nobody_listens');
    expect(r.ok).toBe(true);
    expect(r.messages).toEqual(['Steve: welcome player_join']);
    expect(r.logs).toContain('[ERROR] Error in event handler boom: Division by zero');
    expect(r.logs).toContain('[EVENT] No handler for event: nobody_listens');
  });
  it('validates built-in arguments like the language', () => {
    expect(fails('set_health(get_player("S"), 30)', 'PLAYER S AT 0 0 0')?.message).toBe('set_health() expects health between 0 and 20, got 30.0');
    expect(fails('log(1, 2)')?.message).toBe('log() requires 1 argument, got 2');
    expect(fails('get_player("ghost")')?.message).toBe("Player 'ghost' not found");
    expect(logs('log(split("a,b,,", ","))\nlog(range(3, 0))\nlog(min([4, 2, 9]))\nlog(max(1, 7))\nlog(join([1, 2], "-"))\nlog(to_number("2.5") * 2)\nlog(contains([1, "a"], "a"))')).toEqual(['[a, b]', '[3, 2, 1]', '2', '7', '1-2', '5', 'true']);
  });
  it('reports duplicate PLAYER names as a setup error', () => {
    expect(runQuill('log(1)', 'PLAYER A AT 0 0 0\nPLAYER A AT 1 1 1').error?.kind).toBe('setup');
  });
  it('reads code blocks and setup from a message', () => {
    const { code, rest } = extractCode('PLAYER Bob AT 1 2 3\n```quill\nlog(1)\n```');
    expect(code).toBe('log(1)');
    expect(parseSetup(rest).players).toEqual([{ name: 'Bob', x: 1, y: 2, z: 3 }]);
  });
});

describe('Quill sandbox (worker thread)', () => {
  it('runs scripts off the main thread', async () => {
    const r = await runInSandbox('log(6 * 7)', '');
    expect(r.logs).toEqual(['[LOG] 42']);
  });
  it('kills a script that overruns the hard timeout', async () => {
    const r = await runInSandbox('for i in range(0, 1000) { for j in range(0, 1000) { let a = 1 } }', '', 1);
    expect(r.error?.message).toMatch(/longer than/);
  });
});

describe('Quill embeds', () => {
  it('keeps every field within Discord limits', () => {
    const r = runQuill('for i in range(0, 500) { log("line " + i) }', '');
    const e = resultEmbed(r);
    expect(e.title).toBe('✅ Quill Execution Complete');
    expect(e.fields[0]!.value).toContain('... (480 more lines)');
    for (const f of e.fields) expect(f.value.length).toBeLessThanOrEqual(1024);
    expect(fenced(Array.from({ length: 300 }, () => 'x'.repeat(50))).length).toBeLessThanOrEqual(1024);
  });
  it('labels each error kind', () => {
    expect(resultEmbed(runQuill('let = 1', '')).title).toBe('❌ Parser Error');
    expect(resultEmbed(runQuill('log("x', '')).title).toBe('❌ Lexer Error');
    expect(resultEmbed(runQuill('log(nope)', '')).title).toBe('❌ Runtime Error');
    const help = helpEmbed();
    expect(help.fields.map((f) => f.value).join()).toContain('get_online_players');
  });
});

describe('/quilldocs', () => {
  it('resolves shortcuts, aliases, partial matches and raw paths', () => {
    expect(findDocPath('syntax')).toBe('language/syntax.html');
    expect(findDocPath('player events')).toBe('events/player-events.html');
    expect(findDocPath('types')).toBe('language/data-types.html');
    expect(findDocPath('minigame')).toBe('examples/minigames.html');
    expect(findDocPath('language/functions')).toBe('language/functions.html');
    expect(findDocPath('../../etc/passwd')).toBeNull();
    expect(findDocPath('zzzz')).toBeNull();
  });
  it('converts headings, paragraphs, lists, code, quotes and dividers', () => {
    const html = `<html><body><h1 class="page-title">Syntax</h1><div class="doc-content">
      <nav class="toc">skip me</nav><p>Intro text.</p><h2>Variables</h2><p>Use let.</p>
      <ul><li>one</li><li>two</li></ul><pre>let x = 1</pre><blockquote>Note!</blockquote><hr><h3>More</h3><h4>Minor</h4></div></body></html>`;
    const page = htmlToSections(html)!;
    expect(page.title).toBe('Syntax');
    expect(page.sections[0]).toBe('Intro text.');
    expect(page.sections[1]).toContain('**Variables**');
    expect(page.sections[1]).toContain('• one\n• two');
    expect(page.sections[1]).toContain('```\nlet x = 1\n```');
    expect(page.sections[1]).toContain('> Note!');
    expect(page.sections[1]).toContain('─────');
    expect(page.sections.join()).not.toContain('skip me');
    const e = docsEmbed(page, 'https://example/x');
    expect(e.title).toBe('📜 Syntax');
  });
  it('checks the page exists first', async () => {
    const calls: string[] = [];
    const fake = (async (_u: string, init?: RequestInit) => {
      calls.push(init?.method ?? 'GET');
      return new Response('', { status: 404 });
    }) as unknown as typeof fetch;
    expect(await fetchDocPage('nope.html', fake)).toBe('missing');
    expect(calls).toEqual(['HEAD']);
  });
});

describe('/ver output detection', () => {
  it('reads modern Paper output on the latest version', () => {
    const v = parseVersionOutput('This server is running Paper version 1.21.4-232-main@abc1234 (2025-03-10T09:33:34Z) (Implementing API version 1.21.4-R0.1-SNAPSHOT)\nYou are running the latest version')!;
    expect(v).toMatchObject({ type: 'Paper', mcVersion: '1.21.4', build: '232', api: '1.21.4-R0.1-SNAPSHOT', buildDate: '2025-03-10T09:33:34Z', status: 'latest' });
    expect(versionEmbed(v).color).toBe(0x57f287);
    expect(versionEmbed(v).description).toContain('||```');
  });
  it('flags outdated servers', () => {
    const v = parseVersionOutput('This server is running Paper version git-Paper-196 (MC: 1.20.1) (Implementing API version 1.20.1-R0.1-SNAPSHOT) (Git: 773dd72)\nYou are 12 versions behind\nDownload the new version at: https://papermc.io/downloads/paper')!;
    expect(v).toMatchObject({ mcVersion: '1.20.1', build: '196', status: 'outdated', behind: 12 });
    expect(versionEmbed(v).color).toBe(0xfee75c);
  });
  it('reads Spigot/CraftBukkit and Purpur', () => {
    expect(parseVersionOutput('This server is running CraftBukkit version 4226-Spigot-146439e-2889b3a (MC: 1.20.4) (Implementing API version 1.20.4-R0.1-SNAPSHOT)')).toMatchObject({ type: 'CraftBukkit', mcVersion: '1.20.4', build: '4226', status: 'unknown' });
    expect(parseVersionOutput('This server is running Purpur version 1.21.1-2329-HEAD@7e5f9d8 (2024-10-14T21:51:48Z) (Implementing API version 1.21.1-R0.1-SNAPSHOT)\nYou are running the latest version')).toMatchObject({ type: 'Purpur', build: '2329', status: 'latest' });
    expect(parseVersionOutput('my server is great')).toBeNull();
  });
});

describe('YAML overview', () => {
  it('summarises top-level keys, cutting nested values at 5 per level', () => {
    const y = extractYaml('here:\n```yaml\nprefix: "&a"\nenabled: true\nlist: [1, 2, 3, 4, 5, 6, 7]\ndb:\n  host: localhost\n  port: 3306\n```')!;
    const e = yamlOverview(y);
    expect(e.description).toBe('4 top-level keys.');
    expect(e.fields.map((f) => f.name)).toEqual(['prefix', 'enabled', 'list', 'db']);
    expect(e.fields[2]!.value).toContain('… and 2 more');
    expect(e.fields[3]!.value).toContain('**port**: `3306`');
  });
  it('caps at 25 fields and explains syntax errors', () => {
    const big = Array.from({ length: 40 }, (_, n) => `key${n}: ${n}`).join('\n');
    expect(yamlOverview(big).fields).toHaveLength(MAX_FIELDS);
    const bad = yamlOverview('a: 1\n  b: 2\n c: [');
    expect(bad.title).toBe('⚠️ This YAML has an error');
    expect(bad.description).toMatch(/line \d+/);
    expect(extractYaml('```yml\na: 1\n```')).toBe('a: 1\n');
    expect(extractYaml('no code')).toBeNull();
  });
});

describe('support messages', () => {
  it('fill in the plugin name and paste channel', () => {
    const e = configEmbed('Essentials', '<#123>');
    expect(e.title).toBe('Config Instructions - Essentials');
    expect(e.fields[0]!.value).toBe('`server/plugins/Essentials/config.yml`');
    expect(e.fields[1]!.value).toContain('Upload it directly to <#123>');
    expect(verEmbed('this channel').description).toContain('paste the entire output in this channel');
  });
  it('lists all ten links', () => {
    const doc = parseYaml(readFileSync('content/sudobot/links.yaml', 'utf8'));
    const e = linksEmbed(doc);
    expect(doc.links).toHaveLength(10);
    expect(e.description).toContain('[Install StrikeSystem](https://discord.com/oauth2/authorize?client_id=1409667296582045859)');
  });
});
