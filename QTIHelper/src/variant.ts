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
  name: 'QTIHelper',
  description: 'The official bot of QTI!',
  colors: { primary: 0x5865f2, ok: 0x2ecc71, warn: 0xf1c40f, error: 0xe74c3c, info: 0x3498db, fun: 0xe67e22 },
  presence: { type: 'Playing', text: 'Bearly Magical' },
  links: { support: 'https://discord.gg/FZuVXszuuM' },
  modules: ['info', 'moderation', 'autoresponse', 'scheduler', 'fun', 'config'],
  contentDir: 'content',
  messages: {},
};
