import {
  type ChatInputCommandInteraction,
  EmbedBuilder,
  InteractionContextType,
  MessageFlags,
  PermissionFlagsBits,
  SlashCommandBuilder,
} from 'discord.js';
import type { ProviderInfo } from '../../providers/registry.ts';
import type { BotContext } from '../context.ts';
import { TARGET_CHANNEL_TYPES } from '../permissions.ts';
import { COLORS, respond, UserError } from '../replies.ts';
import { assertCanPost, autocompleteSubscriptions, fitLines } from './creators.ts';
import type { Command } from './types.ts';

export function announcerCommand(catalog: ProviderInfo[]): Command {
  const data = new SlashCommandBuilder()
    .setName('announcer')
    .setDescription('Server-wide announcement settings')
    .setContexts(InteractionContextType.Guild)
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild)
    .addSubcommand((sc) =>
      sc
        .setName('default-channel')
        .setDescription('Set where a platform announces when a creator has no channel of its own')
        .addStringOption((o) =>
          o
            .setName('platform')
            .setDescription('Platform')
            .setRequired(true)
            .addChoices(...catalog.map((p) => ({ name: p.name, value: p.id }))),
        )
        .addChannelOption((o) =>
          o.setName('channel').setDescription('Announcement channel').setRequired(true).addChannelTypes(...TARGET_CHANNEL_TYPES),
        ),
    )
    .addSubcommand((sc) =>
      sc
        .setName('log-channel')
        .setDescription('Where I post problems, such as lost permissions (leave empty to use the system channel)')
        .addChannelOption((o) => o.setName('channel').setDescription('Log channel').addChannelTypes(...TARGET_CHANNEL_TYPES)),
    )
    .addSubcommand((sc) =>
      sc
        .setName('crosspost')
        .setDescription('Publish announcements posted in announcement channels to following servers')
        .addBooleanOption((o) => o.setName('enabled').setDescription('On or off').setRequired(true)),
    )
    .addSubcommand((sc) =>
      sc
        .setName('test')
        .setDescription('Send a sample announcement for a creator, to check permissions and layout')
        .addStringOption((o) =>
          o.setName('subscription').setDescription('Creator').setRequired(true).setAutocomplete(true),
        ),
    )
    .addSubcommand((sc) => sc.setName('settings').setDescription("Show this server's announcement setup"))
    .toJSON();

  return {
    data,
    help: 'Server-wide settings: default channels, log channel, crossposting, test posts',
    async execute(i, ctx) {
      await i.deferReply({ flags: MessageFlags.Ephemeral });
      await ctx.store.ensureGuild(i.guildId!);
      switch (i.options.getSubcommand()) {
        case 'default-channel':
          return defaultChannel(i, ctx);
        case 'log-channel':
          return logChannel(i, ctx);
        case 'crosspost':
          return crosspost(i, ctx);
        case 'test':
          return test(i, ctx);
        default:
          return settings(i, ctx);
      }
    },
    async autocomplete(i, ctx) {
      await autocompleteSubscriptions(i, ctx);
    },
  };
}

async function defaultChannel(i: ChatInputCommandInteraction, ctx: BotContext) {
  const platform = i.options.getString('platform', true);
  const info = ctx.providers.info(platform);
  if (!info) throw new UserError('Unknown platform.');
  const channel = i.options.getChannel('channel', true);
  await assertCanPost(i, channel.id);
  await ctx.store.setDefaultChannel(i.guildId!, platform, channel.id);
  const note = ctx.providers.get(platform) ? '' : `\n⚠️ ${info.name} is not enabled on this bot right now.`;
  await respond(i, { content: `Announcement channel for ${info.name} set to <#${channel.id}>.${note}` });
}

async function logChannel(i: ChatInputCommandInteraction, ctx: BotContext) {
  const channel = i.options.getChannel('channel');
  if (channel) await assertCanPost(i, channel.id);
  await ctx.store.setLogChannel(i.guildId!, channel?.id ?? null);
  await respond(i, {
    content: channel
      ? `Problems will be reported in <#${channel.id}>.`
      : "Problems will be reported in the server's system channel.",
  });
}

async function crosspost(i: ChatInputCommandInteraction, ctx: BotContext) {
  const enabled = i.options.getBoolean('enabled', true);
  await ctx.store.updateGuildSettings(i.guildId!, { crosspost: enabled });
  await respond(i, {
    content: enabled
      ? 'Announcements in announcement channels will be published to following servers.'
      : 'Announcements will no longer be published automatically.',
  });
}

async function test(i: ChatInputCommandInteraction, ctx: BotContext) {
  const sub = await ctx.store.getSubscription(i.guildId!, i.options.getString('subscription', true));
  if (!sub) throw new UserError('Pick a creator from the list.');
  const provider = ctx.providers.get(sub.source.provider);
  if (!provider) throw new UserError(`${sub.source.provider} is not enabled on this bot.`);
  const guild = await ctx.store.getGuild(i.guildId!);
  const channelId = sub.channelId ?? guild.defaultChannels[sub.source.provider];
  if (!channelId) throw new UserError('That creator has no channel and there is no default for the platform.');
  await assertCanPost(i, channelId);

  const message = provider.render(provider.sampleEvent(sub.source), sub.source);
  message.embed.footer = `${message.embed.footer ?? ''} · test`.replace(/^ · /, '');
  if (sub.roleId) {
    message.content = `<@&${sub.roleId}> *(test, nobody was pinged)*`;
    message.allowedRoleIds = [];
  }
  try {
    await ctx.sender.send({ guildId: i.guildId!, channelId, crosspost: false }, message);
  } catch (err) {
    throw new UserError(`The test post failed: ${err instanceof Error ? err.message : 'unknown error'}.`);
  }
  const resumed = sub.state === 'broken';
  if (resumed) await ctx.store.setSubscriptionState(sub.id, 'active');
  await respond(i, {
    content: `Sent a test announcement to <#${channelId}>.${resumed ? ' The subscription was paused and is now active again.' : ''}`,
  });
}

async function settings(i: ChatInputCommandInteraction, ctx: BotContext) {
  const guild = await ctx.store.getGuild(i.guildId!);
  const subs = await ctx.store.listSubscriptions(i.guildId!);
  const embed = new EmbedBuilder().setColor(COLORS.info).setTitle('Announcement settings');

  for (const info of ctx.providers.catalog) {
    const mine = subs.filter((s) => s.source.provider === info.id);
    const channel = guild.defaultChannels[info.id];
    const enabled = ctx.providers.get(info.id) ? '' : ' *(not enabled on this bot)*';
    embed.addFields({
      name: info.name + enabled,
      value: `Default channel: ${channel ? `<#${channel}>` : '*not set*'}\nCreators: ${mine.length}`,
      inline: true,
    });
  }
  embed.addFields(
    { name: 'Log channel', value: guild.logChannelId ? `<#${guild.logChannelId}>` : 'System channel', inline: true },
    { name: 'Crosspost', value: guild.settings.crosspost ? 'On' : 'Off', inline: true },
  );

  const broken = subs.filter((s) => s.state !== 'active');
  if (broken.length) {
    embed.addFields({
      name: `⚠️ Paused (${broken.length})`,
      value: fitLines(
        broken.map((s) => `• ${s.source.displayName} (${s.source.provider}): ${s.state}`),
        1000,
      ),
    });
  }
  await respond(i, { embeds: [embed] });
}
