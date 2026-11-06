import {
  DiscordAPIError,
  EmbedBuilder,
  type Guild,
  type GuildBasedChannel,
  type GuildMember,
  type GuildTextBasedChannel,
  type MessageCreateOptions,
  OverwriteType,
  PermissionFlagsBits,
} from 'discord.js';
import type { RoleFacts } from '../core/lock.ts';
import { SendError, type OverwritePort, type PurgePort } from '../core/ports.ts';
import { allowedMentionsFor, type MentionPolicy, renderTemplate } from '../core/text.ts';
import type { EmbedSpec } from '../services/schedule.ts';
import { variant } from '../variant.ts';

const STAFF_BITS = PermissionFlagsBits.ManageMessages | PermissionFlagsBits.ManageChannels | PermissionFlagsBits.Administrator;

type OverwritableChannel = Extract<GuildBasedChannel, { permissionOverwrites: unknown }>;

export function overwritePort(channel: OverwritableChannel): OverwritePort {
  return {
    async overwrites() {
      return [...channel.permissionOverwrites.cache.values()].map((o) => ({
        id: o.id,
        type: o.type === OverwriteType.Role ? ('role' as const) : ('member' as const),
        allow: new Set(o.allow.toArray()),
        deny: new Set(o.deny.toArray()),
      }));
    },
    async apply(edit) {
      const type = edit.targetType === 'role' ? OverwriteType.Role : OverwriteType.Member;
      const existing = channel.permissionOverwrites.cache.get(edit.targetId);
      if (!existing && Object.values(edit.set).every((v) => v === null)) return;
      await channel.permissionOverwrites.edit(edit.targetId, edit.set, { type, reason: `${variant.name} lock/unlock` });
      if (edit.deleteIfEmpty) {
        const after = channel.permissionOverwrites.cache.get(edit.targetId);
        if (after && after.allow.bitfield === 0n && after.deny.bitfield === 0n) await after.delete(`${variant.name} unlock: restore`);
      }
    },
  };
}

export async function lockFacts(guild: Guild, channel: OverwritableChannel) {
  const me = guild.members.me ?? (await guild.members.fetchMe());
  const roles = new Map<string, RoleFacts>(
    guild.roles.cache.map((r) => [r.id, { id: r.id, position: r.position, staff: (r.permissions.bitfield & STAFF_BITS) !== 0n }]),
  );
  const memberIds = channel.permissionOverwrites.cache.filter((o) => o.type === OverwriteType.Member).map((o) => o.id);
  const members = memberIds.length ? await guild.members.fetch({ user: memberIds }).catch(() => null) : null;
  const staffMemberIds = new Set<string>();
  members?.forEach((m: GuildMember) => {
    if (channel.permissionsFor(m).any(STAFF_BITS)) staffMemberIds.add(m.id);
  });
  return { everyoneId: guild.id, botId: me.id, botTopPosition: me.roles.highest.position, roles, staffMemberIds };
}

export function purgePort(channel: GuildTextBasedChannel): PurgePort {
  return {
    async fetchPage(before) {
      const page = await channel.messages.fetch({ limit: 100, ...(before ? { before } : {}) });
      return [...page.values()]
        .sort((a, b) => b.createdTimestamp - a.createdTimestamp)
        .map((m) => ({ id: m.id, createdAt: m.createdTimestamp, authorId: m.author.id, authorBot: m.author.bot, content: m.content, pinned: m.pinned }));
    },
    async bulkDelete(ids) {
      await channel.bulkDelete(ids, false);
    },
    async deleteOne(id) {
      await channel.messages.delete(id);
    },
  };
}

export function templateVars(o: { guild: Guild; channelId: string; member?: GuildMember | null }) {
  return {
    member: o.member?.displayName,
    'member.mention': o.member ? `<@${o.member.id}>` : undefined,
    'member.id': o.member?.id,
    server: o.guild.name,
    membercount: String(o.guild.memberCount),
    channel: `<#${o.channelId}>`,
  };
}

export function buildOutgoing(content: string, embed: EmbedSpec | null, policy: MentionPolicy, vars: ReturnType<typeof templateVars>): MessageCreateOptions {
  const text = renderTemplate(content, vars);
  const mentions = allowedMentionsFor(policy, text);
  if (!embed) return { content: text, allowedMentions: { ...mentions, parse: [...mentions.parse] } };
  const e = new EmbedBuilder().setColor(embed.color ?? variant.colors.primary);
  if (embed.title) e.setTitle(renderTemplate(embed.title, vars).slice(0, 256));
  if (text) e.setDescription(text.slice(0, 4096));
  if (embed.image) e.setImage(embed.image);
  return { embeds: [e], allowedMentions: { ...mentions, parse: [...mentions.parse] } };
}

export function classifySendError(err: unknown): SendError {
  if (err instanceof SendError) return err;
  if (err instanceof DiscordAPIError) {
    const permanent = [10003, 50001, 50013].includes(Number(err.code)) || err.status === 403 || err.status === 404;
    return new SendError(permanent ? 'the channel is gone or I lost access to it' : err.message, permanent);
  }
  return new SendError(err instanceof Error ? err.message : String(err), false);
}

export function canPost(channel: GuildBasedChannel, me: GuildMember, needEmbeds: boolean): boolean {
  const p = channel.permissionsFor(me);
  const send = channel.isThread() ? PermissionFlagsBits.SendMessagesInThreads : PermissionFlagsBits.SendMessages;
  return Boolean(p?.has([PermissionFlagsBits.ViewChannel, send, ...(needEmbeds ? [PermissionFlagsBits.EmbedLinks] : [])]));
}
