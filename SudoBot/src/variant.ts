import type { MessageKey } from './messages.ts';

export interface Variant {
  name: string;
  description: string;
  colors: { primary: number; ok: number; warn: number; error: number; info: number; fun: number };
  presence: { type: 'Watching' | 'Playing' | 'Listening' | 'Competing'; text: string };
  links: { author?: string; support?: string; source?: string };
  modules: Array<'info' | 'moderation' | 'autoresponse' | 'scheduler' | 'fun' | 'config'>;
  contentDir: string;
  messages: Partial<Record<MessageKey, string>>;
}

export const variant: Variant = {
  name: 'SudoBot',
  description:
    'A community helper: member and server info, channel locks, message purges, canned auto-responses, scheduled messages, and a bit of fun.',
  colors: { primary: 0x5865f2, ok: 0x2ecc71, warn: 0xf1c40f, error: 0xe74c3c, info: 0x3498db, fun: 0xe67e22 },
  presence: { type: 'Watching', text: 'for /help' },
  links: { support: 'https://discord.gg/FZuVXszuuM' },
  modules: ['info', 'moderation', 'autoresponse', 'scheduler', 'fun', 'config'],
  contentDir: 'content',
  messages: {},
};
