import { parse } from 'yaml';
import type { EmbedData } from '../quill/render.ts';

export const MAX_FIELDS = 25;
export const PER_LEVEL = 5;
const MAX_YAML = 20_000;

export function extractYaml(content: string): string | null {
  const m = content.match(/```ya?ml[ \t]*\n([\s\S]*?)```/i);
  return m ? m[1]! : null;
}

const scalar = (v: unknown) => (v === null ? '`null`' : typeof v === 'string' ? (v === '' ? '`""`' : `\`${v.replace(/`/g, "'").slice(0, 100)}\``) : `\`${String(v)}\``);

export function renderValue(v: unknown, depth = 0): string {
  const pad = '  '.repeat(depth);
  if (v === null || typeof v !== 'object') return scalar(v);
  const entries: Array<[string, unknown]> = Array.isArray(v) ? v.map((x) => ['-', x] as [string, unknown]) : Object.entries(v as Record<string, unknown>);
  if (!entries.length) return Array.isArray(v) ? '`[]`' : '`{}`';
  const lines = entries.slice(0, PER_LEVEL).map(([k, x]) => {
    const label = k === '-' ? '•' : `**${k}**:`;
    if (x !== null && typeof x === 'object' && depth < 3) return `${pad}${label}\n${renderValue(x, depth + 1)}`;
    if (x !== null && typeof x === 'object') return `${pad}${label} ${Array.isArray(x) ? `[${x.length} items]` : `{${Object.keys(x).length} keys}`}`;
    return `${pad}${label} ${scalar(x)}`;
  });
  if (entries.length > PER_LEVEL) lines.push(`${pad}… and ${entries.length - PER_LEVEL} more`);
  return lines.join('\n');
}

export function yamlOverview(source: string): EmbedData {
  if (source.length > MAX_YAML) {
    return { title: '📄 YAML overview', color: 0x95a5a6, description: `That config is ${source.length.toLocaleString('en-GB')} characters; I only summarise up to ${MAX_YAML.toLocaleString('en-GB')}.`, fields: [] };
  }
  let doc: unknown;
  try {
    doc = parse(source, { maxAliasCount: 50 });
  } catch (err) {
    const e = err as Error & { linePos?: Array<{ line: number; col: number }> };
    const where = e.linePos?.[0] ? ` (line ${e.linePos[0].line}, column ${e.linePos[0].col})` : '';
    return { title: '⚠️ This YAML has an error', color: 0xfee75c, description: `${e.message.split('\n')[0]}${where}\n\nYAML is picky about indentation: use spaces (not tabs) and keep keys at the same level aligned.`, fields: [] };
  }
  if (doc === null || typeof doc !== 'object' || Array.isArray(doc)) {
    return { title: '📄 YAML overview', color: 0x5865f2, description: `The document is ${Array.isArray(doc) ? 'a list' : 'a single value'}:\n${renderValue(doc)}`.slice(0, 4096), fields: [] };
  }
  const keys = Object.entries(doc as Record<string, unknown>);
  return {
    title: '📄 YAML overview',
    color: 0x5865f2,
    description: `${keys.length} top-level key${keys.length === 1 ? '' : 's'}${keys.length > MAX_FIELDS ? ` (showing the first ${MAX_FIELDS})` : ''}.`,
    fields: keys.slice(0, MAX_FIELDS).map(([k, v]) => {
      const value = renderValue(v);
      return { name: k.slice(0, 256) || '(empty key)', value: value.length > 1024 ? `${value.slice(0, 1020)}…` : value };
    }),
  };
}
