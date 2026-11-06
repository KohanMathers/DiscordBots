import { type Message, PermissionFlagsBits } from 'discord.js';
import type { Module } from '../../modules/types.ts';

export const TRIGGER = /\bbut\s+it['’]?s\s+okay\b/i;
export const REPLY = 'Because he drives a';
export const GIF = 'https://klipy.com/gifs/jaaaag';

const COOLDOWN_MS = 5_000;
const lastFired = new Map<string, number>();

export function shouldFire(content: string): boolean {
  return TRIGGER.test(content);
}

async function onMessage(message: Message<true>): Promise<void> {
  if (message.author.bot || !shouldFire(message.content)) return;
  const last = lastFired.get(message.channelId) ?? 0;
  if (Date.now() - last < COOLDOWN_MS) return;
  const me = message.guild.members.me;
  const perms = me ? message.channel.permissionsFor(me) : null;
  const send = message.channel.isThread() ? PermissionFlagsBits.SendMessagesInThreads : PermissionFlagsBits.SendMessages;
  if (!perms?.has([PermissionFlagsBits.ViewChannel, send, PermissionFlagsBits.ReadMessageHistory])) return;
  lastFired.set(message.channelId, Date.now());

  await message.reply({ content: REPLY, allowedMentions: { parse: [], repliedUser: false } });
  await message.channel.send({ content: GIF, allowedMentions: { parse: [] } });
}

export const jagModule: Module = {
  id: 'jag',
  name: 'Jag',
  description: 'Replies to "But it\'s okay" with "Because he drives a" and the Jag GIF',
  needsMessageContent: true,
  events: { message: (m) => onMessage(m) },
};
