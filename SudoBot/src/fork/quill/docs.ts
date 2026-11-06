import { HTMLElement, parse } from 'node-html-parser';
import { type EmbedData, QUILL_COLOR } from './render.ts';

export const DOCS_BASE = 'https://quill.kmathers.co.uk/docs/';

export const DOC_SHORTCUTS: Record<string, string> = {
  index: 'index.html',
  home: 'index.html',
  'getting-started': 'getting-started.html',
  installation: 'installation.html',
  quickstart: 'quickstart.html',
  configuration: 'configuration.html',
  config: 'configuration.html',
  faq: 'faq.html',
  syntax: 'language/syntax.html',
  'data-types': 'language/data-types.html',
  types: 'language/data-types.html',
  functions: 'language/functions.html',
  scopes: 'language/scopes.html',
  scope: 'language/scopes.html',
  events: 'language/events.html',
  'string-interpolation': 'language/string-interpolation.html',
  strings: 'language/string-interpolation.html',
  player: 'api/player.html',
  world: 'api/world.html',
  utility: 'api/utility.html',
  util: 'api/utility.html',
  constructors: 'api/constructors.html',
  'scope-api': 'api/scope.html',
  commands: 'commands/general.html',
  'script-management': 'commands/script-management.html',
  scripts: 'commands/script-management.html',
  'scope-management': 'commands/scope-management.html',
  'player-events': 'events/player-events.html',
  'block-events': 'events/block-events.html',
  'entity-events': 'events/entity-events.html',
  'world-events': 'events/world-events.html',
  subscopes: 'advanced/subscopes.html',
  'error-handling': 'advanced/error-handling.html',
  errors: 'advanced/error-handling.html',
  'custom-events': 'advanced/custom-events.html',
  'persistent-variables': 'advanced/persistent-variables.html',
  persistent: 'advanced/persistent-variables.html',
  security: 'advanced/security.html',
  examples: 'examples/basic-scripts.html',
  'basic-scripts': 'examples/basic-scripts.html',
  minigames: 'examples/minigames.html',
  'api-integration': 'developer/api-integration.html',
  developer: 'developer/api-integration.html',
};

export function findDocPath(query: string): string | null {
  const q = query.toLowerCase().trim().replace(/\s+/g, '-').replace(/\.html$/, '');
  if (!q) return null;
  if (DOC_SHORTCUTS[q]) return DOC_SHORTCUTS[q]!;
  const partial = Object.keys(DOC_SHORTCUTS)
    .filter((k) => k.includes(q) || q.includes(k))
    .sort((a, b) => Math.abs(a.length - q.length) - Math.abs(b.length - q.length) || a.localeCompare(b))[0];
  if (partial) return DOC_SHORTCUTS[partial]!;
  if (q.includes('/') && /^[a-z0-9_\-/]+$/.test(q) && !q.includes('..')) return `${q}.html`;
  return null;
}

const SECTION_BREAK = '\u0000';
const text = (el: HTMLElement) => el.text.replace(/\s+/g, ' ').trim();

export function htmlToSections(html: string): { title: string; sections: string[] } | null {
  const root = parse(html);
  const title = root.querySelector('.page-title')?.text.trim() || root.querySelector('h1')?.text.trim() || 'Quill Documentation';
  const content = root.querySelector('.doc-content');
  if (!content) return null;
  let out = '';
  for (const el of content.childNodes) {
    if (!(el instanceof HTMLElement)) continue;
    if (['toc', 'breadcrumbs', 'page-meta'].some((c) => el.classList.contains(c))) continue;
    switch (el.tagName.toLowerCase()) {
      case 'h1':
      case 'h2':
        out += `${SECTION_BREAK}**${text(el)}**\n\n`;
        break;
      case 'h3':
        out += `**${text(el)}**\n`;
        break;
      case 'h4':
        out += `*${text(el)}*\n`;
        break;
      case 'p': {
        const t = text(el);
        if (t) out += `${t}\n\n`;
        break;
      }
      case 'ul':
      case 'ol':
        for (const li of el.querySelectorAll('li')) out += `• ${text(li)}\n`;
        out += '\n';
        break;
      case 'pre': {
        let code = el.text.trim();
        if (code.length > 500) code = `${code.slice(0, 500)}\n... (truncated)`;
        if (code) out += `\`\`\`\n${code.replace(/```/g, '`​``')}\n\`\`\`\n\n`;
        break;
      }
      case 'blockquote':
        out += `> ${text(el)}\n\n`;
        break;
      case 'hr':
        out += '─────────────────────\n\n';
        break;
    }
  }
  return { title, sections: out.split(SECTION_BREAK).map((s) => s.trim()).filter(Boolean) };
}

const cut = (s: string, max: number, url: string) => (s.length > max ? `${s.slice(0, max - 40)}…\n\n[Read more](${url})` : s);

export function docsEmbed(page: { title: string; sections: string[] }, url: string): EmbedData {
  const [first = '*This page is empty.*', ...rest] = page.sections;
  const e: EmbedData = { title: `📜 ${page.title}`.slice(0, 256), color: QUILL_COLOR, url, description: cut(first, 3000, url), fields: [], footer: 'Quill Documentation • /quilldocs <topic>' };
  let size = e.title.length + (e.description?.length ?? 0) + 40;
  for (const s of rest.slice(0, 4)) {
    const value = cut(s, 1024, url);
    if (size + value.length > 5800) break;
    e.fields.push({ name: '​', value });
    size += value.length + 1;
  }
  return e;
}

export function usageEmbed(): EmbedData {
  return {
    title: '📚 Quill Documentation Search',
    color: QUILL_COLOR,
    description: 'Search the Quill documentation for specific topics.',
    fields: [
      { name: 'Usage', value: '```\n/quilldocs topic:<topic>\n```' },
      { name: 'Examples', value: '```\n/quilldocs syntax\n/quilldocs player events\n/quilldocs subscopes\n/quilldocs data types\n```' },
      {
        name: 'Available Topics',
        value:
          '• **Language**: syntax, data-types, functions, scopes, events\n• **API**: player, world, utility, constructors\n• **Commands**: scripts, scope-management\n• **Events**: player-events, block-events, entity-events, world-events\n• **Advanced**: subscopes, error-handling, custom-events, persistent, security\n• **Examples**: basic-scripts, minigames',
      },
    ],
    footer: `Full documentation: ${DOCS_BASE}`,
  };
}

const cache = new Map<string, { at: number; page: { title: string; sections: string[] } }>();
const CACHE_MS = 10 * 60_000;

export async function fetchDocPage(path: string, fetchFn: typeof fetch = fetch): Promise<{ title: string; sections: string[] } | 'missing' | 'unparseable'> {
  const hit = cache.get(path);
  if (hit && Date.now() - hit.at < CACHE_MS) return hit.page;
  const url = DOCS_BASE + path;
  const headers = { 'User-Agent': 'SudoBot (Quill docs lookup)' };
  const head = await fetchFn(url, { method: 'HEAD', headers, signal: AbortSignal.timeout(5_000) });
  if (head.status !== 200) return 'missing';
  const res = await fetchFn(url, { headers, signal: AbortSignal.timeout(10_000) });
  if (!res.ok) return 'missing';
  const page = htmlToSections(await res.text());
  if (!page) return 'unparseable';
  cache.set(path, { at: Date.now(), page });
  return page;
}
