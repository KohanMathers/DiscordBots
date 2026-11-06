import { EmbedBuilder, type MessageCreateOptions } from 'discord.js';
import type { AnnouncementMessage, EmbedSpec } from '../core/types.ts';

const LIMITS = { title: 256, description: 4096, footer: 2048 };

export const truncate = (s: string, max: number) => (s.length > max ? `${s.slice(0, max - 1)}…` : s);

export function toEmbed(spec: EmbedSpec): EmbedBuilder {
  const e = new EmbedBuilder()
    .setTitle(truncate(spec.title, LIMITS.title))
    .setDescription(truncate(spec.description, LIMITS.description))
    .setColor(spec.color);
  if (spec.url) e.setURL(spec.url);
  if (spec.imageUrl) e.setImage(spec.imageUrl);
  if (spec.thumbnailUrl) e.setThumbnail(spec.thumbnailUrl);
  if (spec.footer) e.setFooter({ text: truncate(spec.footer, LIMITS.footer) });
  if (spec.timestamp) e.setTimestamp(new Date(spec.timestamp));
  return e;
}

export function toMessage(msg: AnnouncementMessage): MessageCreateOptions {
  return {
    ...(msg.content ? { content: msg.content } : {}),
    embeds: [toEmbed(msg.embed)],
    allowedMentions: { parse: [], roles: msg.allowedRoleIds },
  };
}
