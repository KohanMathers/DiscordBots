import { randomBytes } from 'node:crypto';
import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  type ButtonInteraction,
  type RepliableInteraction,
} from 'discord.js';
import { UserError } from '../core/errors.ts';
import type { ComponentSpec } from '../modules/types.ts';
import { respond } from './replies.ts';

interface Pending {
  userId: string;
  expires: number;
  run(i: ButtonInteraction): Promise<void>;
}

const pending = new Map<string, Pending>();
const TTL_MS = 5 * 60_000;

export async function askConfirmation(
  i: RepliableInteraction,
  text: string,
  run: (button: ButtonInteraction) => Promise<void>,
  danger = 'Confirm',
): Promise<void> {
  for (const [k, p] of pending) if (p.expires < Date.now()) pending.delete(k);
  const nonce = randomBytes(6).toString('hex');
  pending.set(nonce, { userId: i.user.id, expires: Date.now() + TTL_MS, run });
  const row = new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder().setCustomId(`confirm:yes:${nonce}`).setLabel(danger).setStyle(ButtonStyle.Danger),
    new ButtonBuilder().setCustomId(`confirm:no:${nonce}`).setLabel('Cancel').setStyle(ButtonStyle.Secondary),
  );
  await respond(i, { content: `${text}\n-# This expires in 5 minutes.`, components: [row] });
}

export const confirmComponent: ComponentSpec = {
  prefix: 'confirm',
  tier: 'mod',
  async handle(i, _ctx, [answer, nonce = '']) {
    if (!i.isButton()) return;
    const p = pending.get(nonce);
    if (!p || p.expires < Date.now()) {
      pending.delete(nonce);
      await i.update({ content: 'This confirmation expired. Run the command again.', components: [] });
      return;
    }
    if (p.userId !== i.user.id) throw new UserError('Only the moderator who started this can confirm it.');
    pending.delete(nonce);
    if (answer !== 'yes') {
      await i.update({ content: 'Cancelled.', components: [] });
      return;
    }
    await i.update({ content: '⏳ Working on it…', components: [] });
    await p.run(i);
  },
};
