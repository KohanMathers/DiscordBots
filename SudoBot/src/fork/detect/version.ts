import type { EmbedData } from '../quill/render.ts';

export interface ServerVersion {
  type: string;
  version: string;
  mcVersion: string | null;
  build: string | null;
  api: string | null;
  buildDate: string | null;
  status: 'latest' | 'outdated' | 'unknown';
  behind: number | null;
  raw: string;
}

const TRIGGER = /This server is running\s+(\S+)\s+version\s+([^\n]+)/i;

export function parseVersionOutput(content: string): ServerVersion | null {
  const m = content.match(TRIGGER);
  if (!m) return null;
  const start = content.indexOf(m[0]);
  const raw = content.slice(start).split('\n').slice(0, 8).join('\n').replace(/```/g, '').trim();
  const rest = m[2]!;
  const version = rest.split(/\s/)[0]!;

  const mc = rest.match(/\(MC:\s*([\d.]+)\)/i)?.[1] ?? version.match(/^(\d+\.\d+(?:\.\d+)?)(?=[-@+]|$)/)?.[1] ?? null;
  const build =
    version.match(/^\d+\.\d+(?:\.\d+)?-(\d+)/)?.[1] ??
    version.match(/^git-[A-Za-z]+-(\d+)/)?.[1] ??
    version.match(/^(\d+)-/)?.[1] ??
    null;
  const api = rest.match(/Implementing API version\s+([^\s)]+)/i)?.[1] ?? null;
  const buildDate = rest.match(/\((\d{4}-\d{2}-\d{2}T[\d:.]+Z?)\)/)?.[1] ?? null;

  let status: ServerVersion['status'] = 'unknown';
  let behind: number | null = null;
  const b = raw.match(/(\d+)\s+versions?\s+behind/i);
  if (/running the latest version/i.test(raw)) status = 'latest';
  else if (b) {
    status = 'outdated';
    behind = Number(b[1]);
  } else if (/new(?:er)? version|update available|out of date|outdated|download the new version/i.test(raw)) status = 'outdated';

  return { type: m[1]!, version, mcVersion: mc, build, api, buildDate, status, behind, raw };
}

export function versionEmbed(v: ServerVersion): EmbedData {
  const color = v.status === 'latest' ? 0x57f287 : v.status === 'outdated' ? 0xfee75c : 0x95a5a6;
  const statusText =
    v.status === 'latest'
      ? '✅ Up to date'
      : v.status === 'outdated'
        ? `⚠️ Update available${v.behind ? ` (${v.behind} version${v.behind === 1 ? '' : 's'} behind)` : ''}`
        : '❔ Couldn’t tell whether this is the latest version';
  const date = v.buildDate && !Number.isNaN(Date.parse(v.buildDate)) ? `<t:${Math.floor(Date.parse(v.buildDate) / 1000)}:D>` : null;
  const fields = [
    { name: 'Server', value: v.type },
    { name: 'Minecraft', value: v.mcVersion ?? 'unknown' },
    ...(v.build ? [{ name: 'Build', value: v.build }] : []),
    ...(v.api ? [{ name: 'API version', value: `\`${v.api}\`` }] : []),
    ...(date ? [{ name: 'Build date', value: date }] : []),
    { name: 'Status', value: statusText },
  ];
  return {
    title: `🖥️ ${v.type} ${v.mcVersion ?? v.version}`.slice(0, 256),
    color,
    description: `Raw output:\n||\`\`\`\n${v.raw.slice(0, 1500)}\n\`\`\`||`,
    fields,
  };
}
