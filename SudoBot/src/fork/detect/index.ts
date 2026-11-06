import type { Message } from 'discord.js';
import type { Module } from '../../modules/types.ts';
import { toEmbed } from '../quill/index.ts';
import { parseVersionOutput, versionEmbed } from './version.ts';
import { extractYaml, yamlOverview } from './yaml.ts';

async function onMessage(message: Message<true>): Promise<void> {
  if (message.author.bot || !message.content) return;
  const reply = (data: Parameters<typeof toEmbed>[0]) => message.reply({ embeds: [toEmbed(data)], allowedMentions: { parse: [], repliedUser: false } });
  const version = parseVersionOutput(message.content);
  if (version) {
    await reply(versionEmbed(version));
    return;
  }
  const yaml = extractYaml(message.content);
  if (yaml !== null) await reply(yamlOverview(yaml));
}

export const detectModule: Module = {
  id: 'autodetect',
  name: 'Auto-detect',
  description: 'Replies to pasted /ver output and ```yaml configs automatically',
  needsMessageContent: true,
  events: { message: (m) => onMessage(m) },
};
