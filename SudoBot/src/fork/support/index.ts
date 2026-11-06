import { readFileSync } from 'node:fs';
import {
  ActionRowBuilder,
  ApplicationCommandType,
  ContextMenuCommandBuilder,
  InteractionContextType,
  LabelBuilder,
  MessageFlags,
  ModalBuilder,
  SlashCommandBuilder,
  StringSelectMenuBuilder,
  TextInputBuilder,
  TextInputStyle,
} from 'discord.js';
import { parse } from 'yaml';
import { UserError } from '../../core/errors.ts';
import { kinds } from '../../core/settings.ts';
import type { BotContext } from '../../discord/context.ts';
import type { CommandSpec, ComponentSpec, Module } from '../../modules/types.ts';
import { variant } from '../../variant.ts';
import { toEmbed } from '../quill/index.ts';
import type { EmbedData } from '../quill/render.ts';
import { configEmbed, linksEmbed, missingPluginEmbed, PLUGIN_NAME, prndebugEmbed, verEmbed } from './texts.ts';

const links = () => parse(readFileSync(new URL(`../../../${variant.contentDir}/sudobot/links.yaml`, import.meta.url), 'utf8')) as { title?: string; links: Array<{ label: string; url: string }> };

async function pasteWhere(ctx: BotContext, guildId: string): Promise<string> {
  const id = (await ctx.settings.get(guildId)).get<string | null>('support.paste_channel');
  return id ? `<#${id}>` : 'this channel';
}

const simple = (name: string, description: string, build: (ctx: BotContext, guildId: string) => Promise<EmbedData> | EmbedData): CommandSpec => ({
  replyMode: 'public',
  data: new SlashCommandBuilder().setName(name).setDescription(description).setContexts(InteractionContextType.Guild).toJSON(),
  async execute(i, ctx) {
    await i.reply({ embeds: [toEmbed(await build(ctx, i.guildId!))], allowedMentions: { parse: [] } });
  },
});

const pluginconfig: CommandSpec = {
  replyMode: 'public',
  data: new SlashCommandBuilder()
    .setName('pluginconfig')
    .setDescription('Ask someone for a plugin’s config.yml')
    .setContexts(InteractionContextType.Guild)
    .addStringOption((o) => o.setName('plugin').setDescription('Plugin name, e.g. Essentials').setRequired(true).setMaxLength(64))
    .toJSON(),
  async execute(i, ctx) {
    if (!i.isChatInputCommand()) return;
    const plugin = i.options.getString('plugin', true).trim();
    if (!plugin) {
      await i.reply({ embeds: [toEmbed(missingPluginEmbed())], flags: MessageFlags.Ephemeral });
      return;
    }
    if (!PLUGIN_NAME.test(plugin)) throw new UserError('Plugin names can only contain letters, numbers, `.`, `_` and `-`');
    await i.reply({ embeds: [toEmbed(configEmbed(plugin, await pasteWhere(ctx, i.guildId!)))], allowedMentions: { parse: [] } });
  },
};

const sendInstructions: CommandSpec = {
  replyMode: 'ephemeral',
  data: new ContextMenuCommandBuilder().setName('Send support instructions').setType(ApplicationCommandType.Message).setContexts(InteractionContextType.Guild).toJSON(),
  async execute(i) {
    if (!i.isMessageContextMenuCommand()) return;
    const menu = new StringSelectMenuBuilder()
      .setCustomId(`sup:pick:${i.channelId}:${i.targetId}`)
      .setPlaceholder('Which instructions?')
      .addOptions(
        { label: 'Version check (/ver)', value: 'ver' },
        { label: 'Pronouns debug', value: 'prndebug' },
        { label: 'Plugin config.yml…', value: 'config', description: 'You’ll be asked for the plugin name' },
      );
    await i.reply({ content: `Reply to ${i.targetMessage.url} with:`, components: [new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(menu)], flags: MessageFlags.Ephemeral });
  },
};

async function replyTo(ctx: BotContext, channelId: string, messageId: string, embed: EmbedData) {
  const channel = await ctx.client.channels.fetch(channelId).catch(() => null);
  const target = channel?.isTextBased() ? await channel.messages.fetch(messageId).catch(() => null) : null;
  if (!target) throw new UserError('That message is gone');
  await target.reply({ embeds: [toEmbed(embed)], allowedMentions: { parse: [], repliedUser: true } });
}

const components: ComponentSpec = {
  prefix: 'sup',
  async handle(i, ctx, [kind, channelId = '', messageId = '']) {
    const guildId = i.guildId!;
    if (kind === 'pick' && i.isStringSelectMenu()) {
      const choice = i.values[0];
      if (choice === 'config') {
        await i.showModal(
          new ModalBuilder()
            .setCustomId(`sup:cfg:${channelId}:${messageId}`)
            .setTitle('Plugin config instructions')
            .addLabelComponents(new LabelBuilder().setLabel('Plugin name').setTextInputComponent(new TextInputBuilder().setCustomId('plugin').setStyle(TextInputStyle.Short).setRequired(true).setMaxLength(64).setPlaceholder('Essentials'))),
        );
        return;
      }
      await replyTo(ctx, channelId, messageId, choice === 'ver' ? verEmbed(await pasteWhere(ctx, guildId)) : prndebugEmbed());
      await i.update({ content: 'Sent.', components: [] });
      return;
    }
    if (kind === 'cfg' && i.isModalSubmit()) {
      const plugin = i.fields.getTextInputValue('plugin').trim();
      if (!PLUGIN_NAME.test(plugin)) throw new UserError('Plugin names can only contain letters, numbers, `.`, `_` and `-`');
      await replyTo(ctx, channelId, messageId, configEmbed(plugin, await pasteWhere(ctx, guildId)));
      await i.reply({ content: 'Sent.', flags: MessageFlags.Ephemeral });
    }
  },
};

export const supportModule: Module = {
  id: 'support',
  name: 'Support',
  description: 'Links and plugin-support instructions (/ver, /prndebug, /pluginconfig)',
  commands: [
    simple('links', 'My sites, bots and plugins', () => linksEmbed(links())),
    simple('ver', 'Ask someone to run /ver and paste the output', async (ctx, g) => verEmbed(await pasteWhere(ctx, g))),
    simple('prndebug', 'Steps to debug the Pronouns plugin', () => prndebugEmbed()),
    pluginconfig,
    sendInstructions,
  ],
  components: [components],
  settings: [{ key: 'support.paste_channel', description: 'Channel people are told to paste /ver output and configs in (default: “this channel”)', default: null, ...kinds.channel() }],
};
