import { EmbedBuilder } from 'discord.js';
import type { Case, CaseTypeDef, Evidence } from '../core/cases.ts';
import { formatDuration } from '../core/duration.ts';
import { discordTime } from '../core/timestamps.ts';
import { sanitize } from './replies.ts';

const truncate = (s: string, max: number) => (s.length > max ? `${s.slice(0, max - 1)}…` : s);
const who = (id: string | null, botId: string) =>
  !id ? '—' : id === '0' ? '*deleted user*' : id === botId ? 'Automatic' : `<@${id}> (\`${id}\`)`;

function evidenceLines(ev: Evidence[]): string {
  return ev
    .map((e) => {
      if (e.kind === 'message_link') return `🔗 [Message](${e.url})`;
      if (e.kind === 'text') return `💬 “${truncate(sanitize(e.text ?? ''), 300)}”`;
      const size = e.size ? ` (${(e.size / 1_048_576).toFixed(1)} MB)` : '';
      return e.path ? `📎 ${e.filename}${size}` : `📎 [${e.filename}](${e.url})${size} · too large to re-upload`;
    })
    .join('\n');
}

export function caseLogEmbed(c: Case, def: CaseTypeDef, botId: string): EmbedBuilder {
  const inactive = c.status !== 'ACTIVE';
  const e = new EmbedBuilder()
    .setTitle(`${def.icon} ${def.title} · Case #${c.number}${inactive ? ` · ${c.status.toLowerCase()}` : ''}`)
    .setColor(inactive ? 0x95a5a6 : def.color)
    .setTimestamp(new Date(c.createdAt));

  if (c.targetId) e.addFields({ name: 'User', value: who(c.targetId, botId), inline: true });
  e.addFields({ name: 'Moderator', value: who(c.actorId, botId), inline: true });
  if (typeof c.metadata.count === 'number') {
    e.addFields({ name: 'Strikes', value: `${c.metadata.count}/${c.metadata.max ?? '?'}`, inline: true });
  }
  if (c.durationS) e.addFields({ name: 'Duration', value: formatDuration(c.durationS), inline: true });
  if (c.expiresAt && c.type !== 'STRIKE') e.addFields({ name: 'Ends', value: discordTime(c.expiresAt, 'R'), inline: true });
  if (c.expiresAt && c.type === 'STRIKE') e.addFields({ name: 'Expires', value: discordTime(c.expiresAt, 'R'), inline: true });
  if (c.type === 'CONFIG_CHANGE') {
    const m = c.metadata as { key?: string; from?: string; to?: string };
    e.setDescription(`\`${m.key}\`: ${m.from ?? '—'} -> **${m.to ?? '—'}**`);
  } else {
    e.addFields({ name: 'Reason', value: c.reason ? truncate(sanitize(c.reason), 1024) : '*No reason given*' });
  }
  if (c.evidence.length) e.addFields({ name: 'Evidence', value: truncate(evidenceLines(c.evidence), 1024) });

  const notes: string[] = [];
  if (c.parentCase && typeof c.metadata.parentNumber === 'number') notes.push(`Triggered by case #${c.metadata.parentNumber}`);
  if (c.metadata.preemptive) notes.push('Pre-emptive ban (not a member)');
  if (c.metadata.mirrored) notes.push('Done in Discord, recorded from the audit log');
  if (c.metadata.watchlist) notes.push(`Watchlist trigger${c.metadata.addedBy ? ` (added by <@${c.metadata.addedBy}>)` : ''}`);
  if (c.metadata.legacy) notes.push('Imported from the old bot');
  if (c.dmStatus === 'SENT') notes.push('Member was DMed');
  if (c.dmStatus === 'FAILED') notes.push('Could not DM the member');
  if (c.status === 'REVOKED') notes.push(`Revoked by ${who(c.revokedBy, botId)}${c.revokeReason ? `: ${sanitize(c.revokeReason)}` : ''}`);
  if (c.status === 'EXPIRED') notes.push('Expired');
  if (c.status === 'SUPERSEDED') notes.push('Superseded (e.g. unbanned or timeout lifted)');
  if (c.metadata.reasonEditedBy) notes.push(`Reason edited by <@${c.metadata.reasonEditedBy}>`);
  if (notes.length) e.addFields({ name: 'Notes', value: truncate(notes.join('\n'), 1024) });
  if (c.targetId) e.setFooter({ text: `User ID ${c.targetId}` });
  return e;
}

export function caseDmEmbed(
  c: Case,
  def: CaseTypeDef,
  o: { guildName: string; showModerator: boolean; appealText: string | null; strikes?: { count: number; max: number }; willEscalate?: string | null },
): EmbedBuilder {
  const e = new EmbedBuilder()
    .setColor(def.color)
    .setTitle(`${def.icon} You've ${def.dmVerb ?? 'had an action taken'} in ${truncate(o.guildName, 150)}`)
    .addFields({ name: 'Reason', value: c.reason ? truncate(sanitize(c.reason), 1024) : '*No reason given*' })
    .setFooter({ text: `Case #${c.number}` })
    .setTimestamp(new Date(c.createdAt));
  if (c.durationS) e.addFields({ name: 'Duration', value: formatDuration(c.durationS), inline: true });
  if (c.expiresAt && c.type !== 'STRIKE') e.addFields({ name: 'Ends', value: discordTime(c.expiresAt, 'f'), inline: true });
  if (o.strikes) e.addFields({ name: 'Active strikes', value: `${o.strikes.count}/${o.strikes.max}`, inline: true });
  if (c.type === 'STRIKE' && c.expiresAt) e.addFields({ name: 'This strike expires', value: discordTime(c.expiresAt, 'R'), inline: true });
  if (o.willEscalate) e.addFields({ name: 'Next', value: o.willEscalate });
  if (o.showModerator && c.actorId !== '0') e.addFields({ name: 'Moderator', value: `<@${c.actorId}>`, inline: true });
  if (o.appealText) e.addFields({ name: 'Questions or appeals', value: truncate(sanitize(o.appealText), 1024) });
  return e;
}

export function caseLine(c: Case, def: CaseTypeDef, o: { showModerator: boolean; botId: string }): string {
  const status = c.status === 'ACTIVE' ? '' : ` *(${c.status.toLowerCase()})*`;
  const mod = o.showModerator ? ` · by ${c.actorId === o.botId ? 'automation' : `<@${c.actorId}>`}` : '';
  const reason = c.reason ? `: ${truncate(sanitize(c.reason), 80)}` : '';
  return `${def.icon} **#${c.number}** ${def.title}${status} · ${discordTime(c.createdAt, 'd')}${mod}${reason}`;
}
