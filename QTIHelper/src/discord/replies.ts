import {
  type BaseInteraction,
  EmbedBuilder,
  type InteractionReplyOptions,
  MessageFlags,
  type RepliableInteraction,
} from 'discord.js';
import type { Logger } from 'pino';
import { UserError } from '../core/errors.ts';
import { t } from '../messages.ts';
import { variant } from '../variant.ts';

type Payload = Pick<InteractionReplyOptions, 'content' | 'embeds' | 'components' | 'files'>;

export async function respond(i: RepliableInteraction, payload: Payload, opts: { ephemeral?: boolean; users?: string[] } = {}) {
  const body = { ...payload, allowedMentions: { parse: [] as never[], users: opts.users ?? [] } };
  if (i.deferred || i.replied) await i.editReply(body);
  else await i.reply({ ...body, ...(opts.ephemeral ? { flags: MessageFlags.Ephemeral } : {}) });
}

export const embed = (color: keyof typeof variant.colors = 'primary') => new EmbedBuilder().setColor(variant.colors[color]);

const sentence = (s: string) => (/[.!?)]$/.test(s) ? s : `${s}.`);

export async function handleInteractionError(i: BaseInteraction, err: unknown, ref: string, log: Logger, supportUrl: string | undefined) {
  let text: string;
  if (err instanceof UserError) {
    text = `❌ ${sentence(err.message)}`;
  } else {
    log.error({ err, correlation_id: ref, guild_id: i.guildId, actor_id: i.user.id }, 'interaction failed');
    text = `❌ ${t('error.internal')}${supportUrl ? ` (${supportUrl})` : ''}. (ref \`${ref}\`)`;
  }
  if (!i.isRepliable()) return;
  try {
    if (i.deferred || i.replied) await i.followUp({ content: text, flags: MessageFlags.Ephemeral, allowedMentions: { parse: [] } });
    else await i.reply({ content: text, flags: MessageFlags.Ephemeral, allowedMentions: { parse: [] } });
  } catch (replyErr) {
    log.warn({ err: replyErr }, 'could not send error reply');
  }
}
