import { ChannelType, type Client, DiscordAPIError, PermissionFlagsBits } from 'discord.js';
import type { Logger } from 'pino';
import { SendError, type Sender, type SendTarget } from '../core/sender.ts';
import type { AnnouncementMessage } from '../core/types.ts';
import { isTargetChannel, missingSendPermissions } from './permissions.ts';
import { toMessage } from './render.ts';

const MISSING_CODES = new Set([10003, 10004, 10008]);
const FORBIDDEN_CODES = new Set([50001, 50013, 50083]);

export class DiscordSender implements Sender {
  private readonly client: Client;
  private readonly log: Logger;

  constructor(client: Client, log: Logger) {
    this.client = client;
    this.log = log;
  }

  async send(target: SendTarget, message: AnnouncementMessage): Promise<string> {
    const channel = await this.client.channels.fetch(target.channelId).catch((err: unknown) => {
      throw classify(err);
    });
    if (!channel || channel.isDMBased() || !isTargetChannel(channel) || !channel.isSendable()) {
      throw new SendError('missing', 'the channel no longer exists or is not a text channel');
    }
    if (channel.guildId !== target.guildId) throw new SendError('missing', 'the channel belongs to another server');
    const me = channel.guild.members.me;
    if (me) {
      const missing = missingSendPermissions(channel, me);
      if (missing.length) throw new SendError('forbidden', `missing permission: ${missing.join(', ')}`);
    }

    const sent = await channel.send(toMessage(message)).catch((err: unknown) => {
      throw classify(err);
    });

    if (target.crosspost && channel.type === ChannelType.GuildAnnouncement) {
      await sent.crosspost().catch((err: unknown) => this.log.warn({ err, channelId: channel.id }, 'crosspost failed'));
    }
    return sent.id;
  }

  async notifyBroken(guildId: string, logChannelId: string | null, text: string): Promise<void> {
    try {
      const guild = await this.client.guilds.fetch(guildId);
      const channel = logChannelId ? await guild.channels.fetch(logChannelId).catch(() => null) : guild.systemChannel;
      if (!channel || !channel.isSendable() || !guild.members.me) return;
      const perms = channel.permissionsFor(guild.members.me);
      if (!perms?.has([PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages])) return;
      await channel.send({ content: text, allowedMentions: { parse: [] } });
    } catch (err) {
      this.log.warn({ err, guildId }, 'could not post broken-subscription notice');
    }
  }
}

function classify(err: unknown): SendError {
  if (err instanceof SendError) return err;
  if (err instanceof DiscordAPIError) {
    const code = typeof err.code === 'number' ? err.code : -1;
    if (MISSING_CODES.has(code) || err.status === 404) return new SendError('missing', 'the channel no longer exists', { cause: err });
    if (FORBIDDEN_CODES.has(code) || err.status === 403) return new SendError('forbidden', 'the bot is not allowed to post there', { cause: err });
  }
  return new SendError('retryable', err instanceof Error ? err.message : String(err), { cause: err });
}
