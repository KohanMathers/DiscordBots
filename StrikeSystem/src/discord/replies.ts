import { randomBytes } from 'node:crypto';
import {
  type BaseInteraction,
  type EmbedBuilder,
  type InteractionReplyOptions,
  MessageFlags,
  type RepliableInteraction,
} from 'discord.js';
import type { Logger } from 'pino';
import { UserError } from '../core/errors.ts';

export const COLORS = { info: 0x3498db, ok: 0x2ecc71, warn: 0xf1c40f, error: 0xe74c3c, owner: 0xe67e22 };

type Payload = { content?: string; embeds?: EmbedBuilder[]; components?: InteractionReplyOptions['components']; files?: InteractionReplyOptions['files'] };

export async function respond(i: RepliableInteraction, payload: Payload, opts: { ephemeral?: boolean; users?: string[] } = {}) {
  const body = { ...payload, allowedMentions: { parse: [] as never[], users: opts.users ?? [] } };
  if (i.deferred || i.replied) {
    await i.editReply(body);
  } else {
    await i.reply({ ...body, ...(opts.ephemeral !== false ? { flags: MessageFlags.Ephemeral } : {}) });
  }
}

export const ok = (text: string) => `✅ ${text}`;

export async function handleInteractionError(i: BaseInteraction, err: unknown, log: Logger): Promise<void> {
  let text: string;
  if (err instanceof UserError) {
    text = `❌ ${err.message}`;
  } else {
    const ref = randomBytes(4).toString('hex');
    log.error({ err, ref, guildId: i.guildId, userId: i.user.id, kind: i.type }, 'interaction failed');
    text = `❌ Something went wrong on my end. If it keeps happening, give the bot owner this reference: \`${ref}\``;
  }
  if (!i.isRepliable()) return;
  try {
    if (i.deferred || i.replied) await i.followUp({ content: text, flags: MessageFlags.Ephemeral, allowedMentions: { parse: [] } });
    else await i.reply({ content: text, flags: MessageFlags.Ephemeral, allowedMentions: { parse: [] } });
  } catch (replyErr) {
    log.warn({ err: replyErr }, 'could not send error reply');
  }
}

export const sanitize = (s: string) => s.replace(/@(everyone|here)/gi, '@​$1');
