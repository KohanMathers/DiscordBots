import {
  type AutocompleteInteraction,
  type ChatInputCommandInteraction,
  EmbedBuilder,
  type GuildBasedChannel,
  InteractionContextType,
  MessageFlags,
  PermissionFlagsBits,
  type Role,
  SlashCommandBuilder,
} from 'discord.js';
import type { Provider } from '../../core/types.ts';
import type { ProviderInfo } from '../../providers/registry.ts';
import type { SubscriptionView } from '../../storage/store.ts';
import type { BotContext } from '../context.ts';
import { isTargetChannel, missingSendPermissions, TARGET_CHANNEL_TYPES } from '../permissions.ts';
import { truncate } from '../render.ts';
import { respond, UserError } from '../replies.ts';
import type { Command } from './types.ts';

export function creatorCommand(info: ProviderInfo): Command {
  const builder = new SlashCommandBuilder()
    .setName(info.id)
    .setDescription(`Manage ${info.name} announcements`)
    .setContexts(InteractionContextType.Guild)
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild)
    .addSubcommand((sc) => {
      sc.setName('add')
        .setDescription(`Announce a ${info.name} creator in this server`)
        .addStringOption((o) => o.setName(info.input.option).setDescription(info.input.description).setRequired(true))
        .addChannelOption((o) =>
          o
            .setName('channel')
            .setDescription(`Where to post (defaults to the server's ${info.name} channel)`)
            .addChannelTypes(...TARGET_CHANNEL_TYPES),
        )
        .addRoleOption((o) => o.setName('ping').setDescription('Role to mention in each announcement'));
      if (info.filterChoices.length) {
        sc.addStringOption((o) =>
          o
            .setName('types')
            .setDescription('What to announce')
            .addChoices(...info.filterChoices.map((c) => ({ name: c.label, value: c.value }))),
        );
      }
      return sc;
    })
    .addSubcommand((sc) =>
      sc
        .setName('remove')
        .setDescription(`Stop announcing a ${info.name} creator`)
        .addStringOption((o) =>
          o.setName(info.input.option).setDescription('The creator to remove').setRequired(true).setAutocomplete(true),
        ),
    )
    .addSubcommand((sc) => sc.setName('list').setDescription(`List ${info.name} creators announced in this server`));

  return {
    data: builder.toJSON(),
    help: `Manage ${info.name} announcements`,
    async execute(i, ctx) {
      const provider = ctx.providers.get(info.id);
      if (!provider) throw new UserError(`${info.name} is not enabled on this bot.`);
      await i.deferReply({ flags: MessageFlags.Ephemeral });
      await ctx.store.ensureGuild(i.guildId!);
      switch (i.options.getSubcommand()) {
        case 'add':
          return add(i, ctx, info, provider);
        case 'remove':
          return remove(i, ctx, info);
        default:
          return list(i, ctx, info);
      }
    },
    async autocomplete(i, ctx) {
      await autocompleteSubscriptions(i, ctx, info.id);
    },
  };
}

async function add(i: ChatInputCommandInteraction, ctx: BotContext, info: ProviderInfo, provider: Provider) {
  const guildId = i.guildId!;
  const input = i.options.getString(info.input.option, true);
  const channelOpt = i.options.getChannel('channel');
  const role = i.options.getRole('ping') as Role | null;
  const choice = info.filterChoices.find((c) => c.value === i.options.getString('types')) ?? info.filterChoices[0];
  const filters = choice?.kinds ? { kinds: choice.kinds } : null;

  const guild = await ctx.store.getGuild(guildId);
  const targetId = channelOpt?.id ?? guild.defaultChannels[info.id];
  if (!targetId) {
    throw new UserError(
      `There's no ${info.name} announcement channel yet. Pick one with the \`channel\` option, ` +
        `or set a default with \`/announcer default-channel\`.`,
    );
  }
  await assertCanPost(i, targetId);

  const resolved = await provider.resolve(input);
  if (!resolved.ok) throw new UserError(resolved.message);

  const source = await ctx.store.upsertSource(resolved.source);
  const sub = await ctx.store.upsertSubscription({
    guildId,
    sourceId: source.id,
    channelId: channelOpt?.id ?? null,
    roleId: role?.id ?? null,
    filters,
    createdBy: i.user.id,
  });

  let queued = 0;
  try {
    queued = await ctx.detector.syncNewSubscription(provider, source, sub.id, filters);
    if (queued) ctx.kickDispatcher();
  } catch (err) {
    ctx.log.warn({ err, sourceId: source.id }, 'initial sync failed');
  }

  const lines = [
    `**Posts to:** <#${targetId}>${channelOpt ? '' : ' (server default)'}`,
    `**Pings:** ${role ? `<@&${role.id}>` : 'nobody'}`,
  ];
  if (choice) lines.push(`**Announces:** ${choice.label.replace(' (default)', '')}`);
  if (queued) lines.push('', `🔴 ${resolved.source.displayName} is live right now, so an announcement is on its way.`);
  if (role && !role.mentionable && !i.appPermissions?.has(PermissionFlagsBits.MentionEveryone)) {
    lines.push('', `⚠️ <@&${role.id}> isn't mentionable and I don't have **Mention Everyone**, so the ping won't notify anyone.`);
  }

  const embed = new EmbedBuilder()
    .setColor(info.color)
    .setTitle(`${sub.created ? 'Added' : 'Updated'} ${resolved.source.displayName}`)
    .setURL(resolved.source.url)
    .setDescription(lines.join('\n'));
  if (resolved.source.avatarUrl) embed.setThumbnail(resolved.source.avatarUrl);
  await respond(i, { embeds: [embed] });
}

async function remove(i: ChatInputCommandInteraction, ctx: BotContext, info: ProviderInfo) {
  const input = i.options.getString(info.input.option, true);
  const subs = await ctx.store.listSubscriptions(i.guildId!, info.id);
  const sub = findSubscription(subs, input);
  if (!sub) throw new UserError(`**${input}** isn't on this server's ${info.name} list. Check \`/${info.id} list\`.`);
  await ctx.store.removeSubscription(i.guildId!, sub.id);
  await respond(i, {
    embeds: [new EmbedBuilder().setColor(info.color).setDescription(`Removed **${sub.source.displayName}**.`)],
  });
}

async function list(i: ChatInputCommandInteraction, ctx: BotContext, info: ProviderInfo) {
  const subs = await ctx.store.listSubscriptions(i.guildId!, info.id);
  const guild = await ctx.store.getGuild(i.guildId!);
  const fallback = guild.defaultChannels[info.id];
  const lines = subs.map((s) => {
    const where = s.channelId ? `<#${s.channelId}>` : fallback ? `<#${fallback}>` : '*no channel*';
    const extras = [
      s.roleId ? `pings <@&${s.roleId}>` : null,
      s.filters ? info.filterChoices.find((c) => sameKinds(c.kinds, s.filters!.kinds))?.label ?? 'custom filter' : null,
      s.state !== 'active' ? `**${s.state}**` : null,
    ].filter(Boolean);
    return `• [${s.source.displayName}](${s.source.url}) -> ${where}${extras.length ? ` · ${extras.join(' · ')}` : ''}`;
  });
  const embed = new EmbedBuilder()
    .setColor(info.color)
    .setTitle(`${info.name} creators (${subs.length})`)
    .setDescription(lines.length ? fitLines(lines, 4000) : `None yet. Add one with \`/${info.id} add\`.`);
  await respond(i, { embeds: [embed] });
}

export async function assertCanPost(i: ChatInputCommandInteraction, channelId: string): Promise<GuildBasedChannel> {
  const guild = i.guild ?? (await i.client.guilds.fetch(i.guildId!));
  const channel = await guild.channels.fetch(channelId).catch(() => null);
  if (!channel || !isTargetChannel(channel)) {
    throw new UserError(`<#${channelId}> isn't a channel I can announce in (it may have been deleted).`);
  }
  const me = guild.members.me ?? (await guild.members.fetchMe());
  const missing = missingSendPermissions(channel, me);
  if (missing.length) {
    throw new UserError(`I can't post in <#${channel.id}>. I'm missing: **${missing.join(', ')}**.`);
  }
  return channel;
}

export function findSubscription(subs: SubscriptionView[], input: string): SubscriptionView | undefined {
  const q = input.trim().toLowerCase();
  const bare = q.replace(/^@/, '');
  return subs.find(
    (s) =>
      s.id === input ||
      s.source.externalId.toLowerCase() === q ||
      s.source.handle.toLowerCase().replace(/^@/, '') === bare ||
      s.source.displayName.toLowerCase() === q,
  );
}

export async function autocompleteSubscriptions(i: AutocompleteInteraction, ctx: BotContext, provider?: string) {
  if (!i.guildId) return i.respond([]);
  const typed = i.options.getFocused().toLowerCase();
  const subs = await ctx.store.listSubscriptions(i.guildId, provider);
  const choices = subs
    .filter((s) => !typed || s.source.displayName.toLowerCase().includes(typed) || s.source.handle.toLowerCase().includes(typed))
    .slice(0, 25)
    .map((s) => ({
      name: truncate(`${provider ? '' : `${ctx.providers.info(s.source.provider)?.name ?? s.source.provider}: `}${s.source.displayName} (${s.source.handle})`, 100),
      value: s.id,
    }));
  await i.respond(choices);
}

function sameKinds(a: string[] | null, b: string[]): boolean {
  return !!a && a.length === b.length && a.every((k) => b.includes(k));
}

export function fitLines(lines: string[], max: number): string {
  let out = '';
  for (let n = 0; n < lines.length; n++) {
    const next = `${out}${out ? '\n' : ''}${lines[n]}`;
    if (next.length > max - 30) return `${out}\n…and ${lines.length - n} more`;
    out = next;
  }
  return out;
}
