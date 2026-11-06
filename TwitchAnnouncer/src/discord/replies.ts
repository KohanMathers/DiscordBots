import { randomBytes } from 'node:crypto';
import {
  type AutocompleteInteraction,
  type ChatInputCommandInteraction,
  EmbedBuilder,
  MessageFlags,
} from 'discord.js';
import type { Logger } from 'pino';

export const COLORS = { info: 0x3498db, ok: 0x2ecc71, warn: 0xf1c40f, error: 0xe74c3c, owner: 0xe67e22 };

export class UserError extends Error {
  override readonly name = 'UserError';
}

export async function respond(
  i: ChatInputCommandInteraction,
  content: { content?: string; embeds?: EmbedBuilder[] },
  ephemeral = true,
): Promise<void> {
  const payload = { ...content, allowedMentions: { parse: [] } };
  if (i.deferred || i.replied) {
    await i.editReply(payload);
  } else {
    await i.reply({ ...payload, ...(ephemeral ? { flags: MessageFlags.Ephemeral } : {}) });
  }
}

export function errorEmbed(text: string): EmbedBuilder {
  return new EmbedBuilder().setColor(COLORS.error).setDescription(`❌ ${text}`);
}

export async function handleCommandError(i: ChatInputCommandInteraction, err: unknown, log: Logger): Promise<void> {
  let text: string;
  if (err instanceof UserError) {
    text = err.message;
  } else {
    const ref = randomBytes(4).toString('hex');
    log.error({ err, ref, command: i.commandName, guildId: i.guildId, userId: i.user.id }, 'command failed');
    text = `Something went wrong on my end. If it keeps happening, give the bot owner this reference: \`${ref}\``;
  }
  try {
    await respond(i, { embeds: [errorEmbed(text)] });
  } catch (replyErr) {
    log.warn({ err: replyErr }, 'could not send error reply');
  }
}

export async function safeAutocomplete(i: AutocompleteInteraction, log: Logger, fn: () => Promise<void>) {
  try {
    await fn();
  } catch (err) {
    log.warn({ err, command: i.commandName }, 'autocomplete failed');
    await i.respond([]).catch(() => undefined);
  }
}
