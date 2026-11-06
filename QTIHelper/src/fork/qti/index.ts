import {
  CategoryChannel,
  ChannelType,
  type GuildChannelCreateOptions,
  type GuildBasedChannel,
  InteractionContextType,
  type OverwriteResolvable,
  PermissionFlagsBits,
  SlashCommandBuilder,
} from 'discord.js';
import { UserError } from '../../core/errors.ts';
import { embed, respond } from '../../discord/replies.ts';
import type { CommandSpec, Module } from '../../modules/types.ts';
import { qtiRolesSetting, requireQti } from './access.ts';
import { qtiConfig } from './config.ts';
import { normaliseTextName, renameForClone } from './rename.ts';

const COPYABLE = new Set([ChannelType.GuildText, ChannelType.GuildAnnouncement, ChannelType.GuildForum, ChannelType.GuildMedia, ChannelType.GuildVoice, ChannelType.GuildStageVoice]);

const overwritesOf = (c: { permissionOverwrites: { cache: Map<string, { id: string; type: number; allow: { bitfield: bigint }; deny: { bitfield: bigint } }> } }): OverwriteResolvable[] =>
  [...c.permissionOverwrites.cache.values()].map((o) => ({ id: o.id, type: o.type, allow: o.allow.bitfield, deny: o.deny.bitfield }));

function copyOptions(src: GuildBasedChannel, name: string, parent: string, maxBitrate: number): GuildChannelCreateOptions | null {
  if (!COPYABLE.has(src.type) || !('permissionOverwrites' in src)) return null;
  const base = {
    name,
    parent,
    permissionOverwrites: 'permissionsLocked' in src && src.permissionsLocked ? undefined : overwritesOf(src as never),
  };
  switch (src.type) {
    case ChannelType.GuildText:
      return { ...base, type: ChannelType.GuildText, name: normaliseTextName(name), topic: src.topic ?? undefined, nsfw: src.nsfw, rateLimitPerUser: src.rateLimitPerUser, defaultAutoArchiveDuration: src.defaultAutoArchiveDuration ?? undefined };
    case ChannelType.GuildAnnouncement:
      return { ...base, type: ChannelType.GuildAnnouncement, name: normaliseTextName(name), topic: src.topic ?? undefined, nsfw: src.nsfw, defaultAutoArchiveDuration: src.defaultAutoArchiveDuration ?? undefined };
    case ChannelType.GuildForum:
    case ChannelType.GuildMedia:
      return {
        ...base,
        type: src.type,
        name: normaliseTextName(name),
        topic: src.topic ?? undefined,
        nsfw: src.nsfw,
        rateLimitPerUser: src.rateLimitPerUser ?? undefined,
        availableTags: src.availableTags.map((t) => ({ name: t.name, moderated: t.moderated, emoji: t.emoji })),
        defaultReactionEmoji: src.defaultReactionEmoji ?? undefined,
        defaultThreadRateLimitPerUser: src.defaultThreadRateLimitPerUser ?? undefined,
        defaultSortOrder: src.defaultSortOrder ?? undefined,
        ...(src.type === ChannelType.GuildForum ? { defaultForumLayout: src.defaultForumLayout } : {}),
      } as GuildChannelCreateOptions;
    case ChannelType.GuildVoice:
      return { ...base, type: ChannelType.GuildVoice, bitrate: Math.min(src.bitrate, maxBitrate), userLimit: src.userLimit, rtcRegion: src.rtcRegion ?? undefined, videoQualityMode: src.videoQualityMode ?? undefined, nsfw: src.nsfw };
    case ChannelType.GuildStageVoice:
      return { ...base, type: ChannelType.GuildStageVoice, bitrate: Math.min(src.bitrate, maxBitrate), userLimit: src.userLimit, rtcRegion: src.rtcRegion ?? undefined };
    default:
      return null;
  }
}

const clonecat: CommandSpec = {
  replyMode: 'ephemeral',
  slow: true,
  cooldownS: 10,
  botPermissions: [PermissionFlagsBits.ManageChannels, PermissionFlagsBits.ManageRoles],
  data: new SlashCommandBuilder()
    .setName('clonecat')
    .setDescription('Copy a channel category, its channels and permissions, under a new name')
    .setContexts(InteractionContextType.Guild)
    .addChannelOption((o) => o.setName('category').setDescription('Category to copy').setRequired(true).addChannelTypes(ChannelType.GuildCategory))
    .addStringOption((o) => o.setName('prefix').setDescription('New channel prefix (replaces the part before the first "-")').setRequired(true).setMaxLength(40))
    .addStringOption((o) => o.setName('name').setDescription('Name for the new category').setRequired(true).setMaxLength(100))
    .toJSON(),
  async execute(i, ctx) {
    if (!i.isChatInputCommand()) return;
    await requireQti(i, ctx, 'clone categories');
    const guild = i.guild!;
    const source = await guild.channels.fetch(i.options.getChannel('category', true).id);
    if (!(source instanceof CategoryChannel)) throw new UserError('Pick a category');
    const prefix = i.options.getString('prefix', true).trim();
    const name = i.options.getString('name', true).trim();
    const children = [...source.children.cache.values()].sort((a, b) => a.rawPosition - b.rawPosition);
    if (children.length + guild.channels.cache.size + 1 > 500) throw new UserError('That would go over Discord’s 500-channel limit for a server');

    const created: GuildBasedChannel[] = [];
    const skipped: string[] = [];
    try {
      const category = await guild.channels.create({ name, type: ChannelType.GuildCategory, permissionOverwrites: overwritesOf(source as never), position: source.rawPosition + 1, reason: `/clonecat by ${i.user.username}` });
      created.push(category);
      for (const child of children) {
        let opts = copyOptions(child, renameForClone(child.name, prefix), category.id, guild.maximumBitrate);
        if (!opts) {
          skipped.push(`${child.name} (unsupported type)`);
          continue;
        }
        if (opts.type === ChannelType.GuildAnnouncement && !guild.features.includes('NEWS')) {
          opts = { ...opts, type: ChannelType.GuildText };
          skipped.push(`${child.name} -> created as a text channel (server has no announcement channels)`);
        }
        created.push(await guild.channels.create({ ...opts, reason: `/clonecat by ${i.user.username}` }));
        if (created.length % 5 === 0) await i.editReply({ content: `Copying… ${created.length - 1}/${children.length}` }).catch(() => undefined);
      }
    } catch (err) {
      for (const c of created.reverse()) await c.delete('clonecat failed, rolling back').catch(() => undefined);
      ctx.log.warn({ err, guild_id: guild.id }, 'clonecat failed');
      throw new UserError(`Copying failed (${(err as Error).message}), so I removed the partial copy. Check my **Manage Channels** and **Manage Roles** permissions and that my role is above the roles in those overrides`);
    }

    await ctx.audit.record({ guildId: guild.id, actorId: i.user.id, action: 'clonecat', target: created[0]!.id, payload: { source: source.id, prefix, channels: created.length - 1 } });
    ctx.kickWorker();
    const list = created.slice(1).map((c) => `<#${c.id}>`).join('\n') || '*no channels*';
    const e = embed('ok')
      .setTitle(`📁 Copied ${source.name} -> ${name}`)
      .setDescription(list.slice(0, 4000))
      .setFooter({ text: `${created.length - 1} channel${created.length === 2 ? '' : 's'} created` });
    if (skipped.length) e.addFields({ name: 'Notes', value: skipped.join('\n').slice(0, 1024) });
    await respond(i, { content: '', embeds: [e] });
  },
};

export async function postMotd(text: string, cfg = qtiConfig(), fetchFn: typeof fetch = fetch): Promise<void> {
  if (!cfg.QTI_MOTD_TOKEN) throw new UserError('The MOTD API isn’t set up on this bot (QTI_MOTD_TOKEN is missing)');
  let res: Response;
  try {
    res = await fetchFn(cfg.QTI_MOTD_URL, {
      method: 'POST',
      headers: { Authorization: `Bearer ${cfg.QTI_MOTD_TOKEN}`, 'Content-Type': 'application/json', 'User-Agent': 'QTIHelper' },
      body: JSON.stringify({ motd: text }),
      signal: AbortSignal.timeout(10_000),
    });
  } catch (err) {
    throw new UserError(`I couldn’t reach the MOTD API (${(err as Error).name === 'TimeoutError' ? 'timed out' : 'connection failed'}). Try again later`);
  }
  if (!res.ok) {
    throw new UserError(res.status === 401 || res.status === 403 ? 'The MOTD API rejected my token. Check QTI_MOTD_TOKEN' : `The MOTD API answered ${res.status}. Try again later`);
  }
}

const motd: CommandSpec = {
  replyMode: 'ephemeral',
  slow: true,
  cooldownS: 5,
  data: new SlashCommandBuilder()
    .setName('motd')
    .setDescription('Set the QTI message of the day')
    .setContexts(InteractionContextType.Guild)
    .addStringOption((o) => o.setName('text').setDescription('The new message of the day').setRequired(true).setMaxLength(500))
    .toJSON(),
  async execute(i, ctx) {
    if (!i.isChatInputCommand()) return;
    await requireQti(i, ctx, 'set the MOTD');
    const text = i.options.getString('text', true).trim();
    await postMotd(text);
    await ctx.audit.record({ guildId: i.guildId!, actorId: i.user.id, action: 'motd', payload: { motd: text } });
    ctx.kickWorker();
    await respond(i, { embeds: [embed('ok').setTitle('✅ MOTD updated').setDescription(text)] });
  },
};

export const qtiModule: Module = {
  id: 'qti',
  name: 'QTI tools',
  description: 'Category cloning and the QTI message of the day',
  commands: [clonecat, motd],
  settings: [qtiRolesSetting],
};

