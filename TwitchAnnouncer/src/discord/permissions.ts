import {
  ChannelType,
  type GuildBasedChannel,
  type GuildMember,
  PermissionFlagsBits,
  PermissionsBitField,
} from 'discord.js';

export const TARGET_CHANNEL_TYPES = [
  ChannelType.GuildText,
  ChannelType.GuildAnnouncement,
  ChannelType.PublicThread,
  ChannelType.PrivateThread,
  ChannelType.AnnouncementThread,
] as const;

const NAMES: Record<string, string> = {
  ViewChannel: 'View Channel',
  SendMessages: 'Send Messages',
  SendMessagesInThreads: 'Send Messages in Threads',
  EmbedLinks: 'Embed Links',
};

export function missingSendPermissions(channel: GuildBasedChannel, me: GuildMember): string[] {
  const needed = [
    PermissionFlagsBits.ViewChannel,
    channel.isThread() ? PermissionFlagsBits.SendMessagesInThreads : PermissionFlagsBits.SendMessages,
    PermissionFlagsBits.EmbedLinks,
  ];
  const have = channel.permissionsFor(me);
  if (!have) return needed.map(name);
  return needed.filter((p) => !have.has(p)).map(name);
}

const name = (bit: bigint) => {
  const key = new PermissionsBitField(bit).toArray()[0] ?? 'Unknown';
  return NAMES[key] ?? key;
};

export function isTargetChannel(channel: { type: ChannelType }): boolean {
  return (TARGET_CHANNEL_TYPES as readonly ChannelType[]).includes(channel.type);
}
