import {
  ApplicationCommandOptionType,
  EmbedBuilder,
  InteractionContextType,
  MessageFlags,
  PermissionFlagsBits,
  SlashCommandBuilder,
} from 'discord.js';
import type { BotContext } from '../context.ts';
import { COLORS, respond, UserError } from '../replies.ts';
import type { Command } from './types.ts';

export const pingCommand: Command = {
  data: new SlashCommandBuilder()
    .setName('ping')
    .setDescription('Check the bot is responding')
    .setContexts(InteractionContextType.Guild)
    .toJSON(),
  help: 'Check the bot is responding',
  async execute(i) {
    await i.reply('Pong!');
  },
};

export function helpCommand(all: () => Command[]): Command {
  return {
    data: new SlashCommandBuilder()
      .setName('help')
      .setDescription('List every command')
      .setContexts(InteractionContextType.Guild)
      .toJSON(),
    help: 'List every command',
    async execute(i) {
      const lines: string[] = [];
      for (const cmd of all()) {
        if (cmd.data.name === 'status') continue;
        const subs = (cmd.data.options ?? []).filter((o) => o.type === ApplicationCommandOptionType.Subcommand);
        if (subs.length === 0) lines.push(`**/${cmd.data.name}** — ${cmd.help}`);
        for (const sc of subs) lines.push(`**/${cmd.data.name} ${sc.name}** — ${sc.description}`);
      }
      const embed = new EmbedBuilder()
        .setColor(COLORS.info)
        .setTitle('Commands')
        .setDescription(lines.join('\n'))
        .setFooter({ text: 'Setup commands need the Manage Server permission.' });
      await i.reply({ embeds: [embed] });
    },
  };
}

export const infoCommand: Command = {
  data: new SlashCommandBuilder()
    .setName('info')
    .setDescription('About this bot')
    .setContexts(InteractionContextType.Guild)
    .toJSON(),
  help: 'About this bot',
  async execute(i, ctx) {
    const { INFO_AUTHOR_URL, INFO_SUPPORT_URL, INFO_SOURCE_URL } = ctx.config;
    const links = [
      INFO_AUTHOR_URL && `[Author](${INFO_AUTHOR_URL})`,
      INFO_SUPPORT_URL && `[Support server](${INFO_SUPPORT_URL})`,
      INFO_SOURCE_URL && `[Source code](${INFO_SOURCE_URL})`,
    ].filter(Boolean);
    const embed = new EmbedBuilder()
      .setColor(COLORS.info)
      .setTitle(ctx.client.user?.username ?? 'TwitchAnnouncer')
      .setDescription(
        'Posts an announcement when a Twitch creator goes live or a YouTube channel uploads.\n\n' +
          (links.length ? `${links.join(' · ')}\n\n` : '') +
          'Use `/help` to see every command.',
      )
      .addFields({ name: 'Version', value: ctx.version, inline: true });
    if (ctx.client.user) embed.setThumbnail(ctx.client.user.displayAvatarURL());
    await i.reply({ embeds: [embed] });
  },
};

export const statusCommand: Command = {
  data: new SlashCommandBuilder()
    .setName('status')
    .setDescription('Bot diagnostics (bot owners only)')
    .setContexts(InteractionContextType.Guild)
    .setDefaultMemberPermissions(PermissionFlagsBits.Administrator)
    .toJSON(),
  help: 'Bot diagnostics (bot owners only)',
  async execute(i, ctx) {
    if (!ctx.isOwner(i.user.id)) throw new UserError('Only the bot owner can use this.');
    await i.deferReply({ flags: MessageFlags.Ephemeral });
    await respond(i, { embeds: [await statusEmbed(ctx)] });
  },
};

async function statusEmbed(ctx: BotContext): Promise<EmbedBuilder> {
  const counts = await ctx.store.counts();
  const outbox = await ctx.store.pendingDeliveryCount();
  const embed = new EmbedBuilder()
    .setColor(COLORS.owner)
    .setTitle('Status')
    .addFields(
      { name: 'Uptime', value: formatDuration(Date.now() - ctx.startedAt.getTime()), inline: true },
      { name: 'Gateway ping', value: `${Math.round(ctx.client.ws.ping)} ms`, inline: true },
      { name: 'Servers', value: String(counts.guilds), inline: true },
      { name: 'Outbox', value: `${outbox} pending`, inline: true },
      { name: 'Paused subscriptions', value: String(counts.broken), inline: true },
      { name: 'Version', value: ctx.version, inline: true },
    );

  for (const info of ctx.providers.catalog) {
    const provider = ctx.providers.get(info.id);
    if (!provider) {
      embed.addFields({ name: info.name, value: 'Disabled (no credentials)', inline: false });
      continue;
    }
    const last = ctx.detector.lastOutcome.get(info.id);
    const lastLine = last
      ? `${last.ok ? '✅' : '❌'} <t:${Math.floor(Date.parse(last.at) / 1000)}:R> · ${last.sources} sources · ` +
        `${last.newItems} new · ${last.errors} errors${last.message ? ` · ${last.message}` : ''}`
      : 'not polled yet';
    const extra = Object.entries(provider.status()).map(([k, v]) => `${k}: ${v}`);
    embed.addFields({
      name: info.name,
      value: [`Sources: ${counts.sourcesByProvider[info.id] ?? 0}`, `Last poll: ${lastLine}`, ...extra].join('\n'),
      inline: false,
    });
  }
  return embed;
}

export function formatDuration(ms: number): string {
  const s = Math.floor(ms / 1000);
  const d = Math.floor(s / 86400);
  const h = Math.floor((s % 86400) / 3600);
  const m = Math.floor((s % 3600) / 60);
  return [d && `${d}d`, (d || h) && `${h}h`, `${m}m`].filter(Boolean).join(' ');
}
