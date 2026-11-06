import { PLAYER_FUNCTIONS, UTILITY_FUNCTIONS, WORLD_FUNCTIONS } from './builtins.ts';
import { coord } from './runtime.ts';
import type { RunResult } from './run.ts';

export const QUILL_COLOR = 0x00a19b;
const GREEN = 0x57f287;
const RED = 0xed4245;

export interface EmbedData {
  title: string;
  color: number;
  description?: string;
  fields: Array<{ name: string; value: string }>;
  footer?: string;
  url?: string;
}

export function fenced(lines: string[], maxLines = Infinity): string {
  const shown: string[] = [];
  let used = 8;
  for (const [n, raw] of lines.entries()) {
    const line = raw.replace(/```/g, '`​``');
    const tail = `... (${lines.length - n} more lines)`;
    if (n >= maxLines || used + line.length + 1 > 1024 - tail.length - 2) {
      shown.push(tail);
      break;
    }
    shown.push(line);
    used += line.length + 1;
  }
  return `\`\`\`\n${shown.join('\n')}\n\`\`\``;
}

const HINTS: Record<string, string> = {
  lexer: 'Check for:\n• Unclosed strings\n• Invalid characters\n• Unterminated comments',
  parser: 'Check for:\n• Unmatched brackets/parentheses\n• A missing `{` after `if`, `while`, `for` or a function\n• A keyword used as a name',
  runtime: 'Common causes:\n• Undefined variables\n• Type mismatches\n• Division by zero\n• Invalid function arguments',
  limit: 'The simulator stops scripts that loop forever, recurse without end, or grow huge. Check your loop conditions.',
  setup: 'Check your `PLAYER <name> AT <x> <y> <z>` lines: each name can only be used once.',
};
const TITLES: Record<string, string> = { lexer: 'Lexer Error', parser: 'Parser Error', runtime: 'Runtime Error', limit: 'Execution Stopped', setup: 'Setup Error' };

export function resultEmbed(r: RunResult): EmbedData {
  if (!r.ok && r.error) {
    const e: EmbedData = {
      title: `❌ ${TITLES[r.error.kind] ?? 'Error'}`,
      color: RED,
      description: `${r.error.kind === 'runtime' ? 'Error during script execution:' : r.error.kind === 'lexer' ? 'Failed to tokenize the code:' : r.error.kind === 'parser' ? 'Failed to parse the code:' : ''}\n\`\`\`\n${r.error.message.slice(0, 1500)}\n\`\`\`\n${HINTS[r.error.kind] ?? ''}`.trim(),
      fields: [],
    };
    if (r.logs.length) e.fields.push({ name: 'Logs before the error', value: fenced(r.logs.slice(-20)) });
    return e;
  }
  const e: EmbedData = { title: '✅ Quill Execution Complete', color: GREEN, fields: [], footer: `Executed ${r.logs.length + r.droppedLogs} operations` };
  if (r.logs.length) e.fields.push({ name: 'Execution Logs', value: fenced(r.droppedLogs ? [...r.logs, `(+${r.droppedLogs} not kept)`] : r.logs, 20) });
  if (r.messages.length) e.fields.push({ name: 'Messages', value: fenced(r.messages) });
  if (r.players.length) {
    e.fields.push({ name: 'Player States', value: fenced(r.players.map((p) => `${p.name} | HP: ${p.health.toFixed(1)} | Pos: (${p.x.toFixed(1)}, ${p.y.toFixed(1)}, ${p.z.toFixed(1)}) | Mode: ${p.gamemode}`)) });
  }
  const changed = r.worlds.length > 1 || r.worlds.some((w) => w.time !== 0 || w.weather !== 'clear');
  if (changed) e.fields.push({ name: 'World States', value: fenced(r.worlds.map((w) => `${w.name} | Time: ${w.time} | Weather: ${w.weather}`)) });
  if (!e.fields.length) e.description = 'The script ran without logging anything. Use `log(value)` to see output.';
  return e;
}

export function helpEmbed(): EmbedData {
  const list = (names: string[]) => `\`\`\`\n${names.join(', ')}\n\`\`\``;
  return {
    title: 'Quill Simulator Help',
    color: QUILL_COLOR,
    description:
      'Run Quill with `/quill` (a form opens), or right-click a message containing a ```quill code block -> **Apps -> Run Quill**. ' +
      'Setup lines go in the form’s Setup box, or anywhere outside the code block in the message.',
    fields: [
      {
        name: 'Setup: players',
        value: '```\nPLAYER <name> AT <x> <y> <z>\n```Case-insensitive; names are letters, numbers and `_`; coordinates may be decimals or negative. Use several lines for several players, e.g.\n```\nPLAYER IEatSystemFiles AT 0 64 0\nPLAYER HannahFaun AT 10 64 10\n```',
      },
      {
        name: 'Setup: events',
        value: '```\nEVENT <name> [player]\n```Fires an `OnEvent(<name>)` handler after the script, with `event` (a map) and `player` set. Up to 100 events run per script.',
      },
      {
        name: 'Syntax',
        value:
          '```\nlet x = 5          const MAX = 10\nfunc add(a, b) { return a + b }\nif x > 3 { … } else if x == 3 { … } else { … }\nwhile x > 0 { x = x - 1 }\nfor p in get_online_players() { log(get_name(p)) }\nbreak  continue  try { … } catch err { log(err) }\nlet l = [1, 2, 3]   let m = {name: "Steve", hp: 20}\nl[0]  m.name  m["hp"]\nOnEvent(player_join) { sendmessage(player, "hi") }\nlet area = new Scope(0, 0, 0, 10, 10, 10)\n```Operators: `+ - * / %  == != > < >= <=  && || !`. Comments: `//` and `/* */`.',
      },
      { name: 'Utility functions', value: list(UTILITY_FUNCTIONS) },
      { name: 'Player functions', value: list(PLAYER_FUNCTIONS) },
      { name: 'World functions', value: list(WORLD_FUNCTIONS) },
      { name: 'Limits', value: 'Loops stop after 10,000 iterations; a run stops after 5 seconds, 200 nested calls, or strings/lists past 100,000 entries.' },
    ],
    footer: 'All functions use the same syntax as Quill · /quilldocs <topic> for the full docs',
  };
}

export { coord };
