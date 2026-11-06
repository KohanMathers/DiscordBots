import { randomBytes } from 'node:crypto';
import {
  ActionRowBuilder,
  AttachmentBuilder,
  ButtonBuilder,
  ButtonStyle,
  ChannelSelectMenuBuilder,
  ChannelType,
  InteractionContextType,
  type MessageComponentInteraction,
  MessageFlags,
  PermissionFlagsBits,
  SlashCommandBuilder,
  StringSelectMenuBuilder,
} from 'discord.js';
import { UserError } from '../../core/errors.ts';
import type { SettingValue } from '../../core/settings.ts';
import { canPost } from '../../discord/adapters.ts';
import type { BotContext } from '../../discord/context.ts';
import { embed, respond } from '../../discord/replies.ts';
import type { CommandSpec, ComponentSpec, Module } from '../types.ts';

const MG = PermissionFlagsBits.ManageGuild;
const COMMON_ZONES = ['UTC', 'Europe/London', 'Europe/Dublin', 'Europe/Paris', 'Europe/Berlin', 'Europe/Madrid', 'Europe/Amsterdam', 'Europe/Stockholm', 'Europe/Athens', 'Europe/Moscow', 'America/New_York', 'America/Chicago', 'America/Denver', 'America/Los_Angeles', 'America/Toronto', 'America/Sao_Paulo', 'Asia/Kolkata', 'Asia/Tokyo', 'Australia/Sydney', 'Pacific/Auckland'];
const GRACE = [1, 6, 24, 72, 168];

async function changeSettings(ctx: BotContext, guildId: string, actorId: string, patch: Record<string, SettingValue | undefined>) {
  const before = await ctx.settings.get(guildId);
  await ctx.guilds.ensure(guildId);
  await ctx.db.transaction().execute(async (trx) => {
    await ctx.settings.set(guildId, patch, trx);
    for (const [key, value] of Object.entries(patch)) {
      await ctx.audit.record({ guildId, actorId, action: 'config.set', target: key, payload: { from: before.get(key) ?? null, to: value ?? null } }, trx);
    }
  });
  ctx.settings.invalidate(guildId);
  ctx.kickWorker();
}

const optional = (ctx: BotContext) => ctx.modules.filter((m) => !m.required);

async function panel(ctx: BotContext, guildId: string) {
  const s = await ctx.settings.get(guildId);
  const mods = optional(ctx);
  const enabled = mods.filter((m) => s.get(`module.${m.id}.enabled`) !== false);
  const e = embed('info')
    .setTitle('⚙️ Settings')
    .setDescription('Changes save as soon as you pick. For anything else use `/config set`.')
    .addFields(
      { name: 'Log channel', value: s.logChannel ? `<#${s.logChannel}>` : '*not set*', inline: true },
      { name: 'Time zone', value: `\`${s.timezone}\``, inline: true },
      { name: 'Mass mentions in saved content', value: s.get('mentions.allow_mass') ? 'allowed' : 'blocked', inline: true },
      ...(ctx.settings.registry.get('schedule.grace_hours') ? [{ name: 'Late-send grace', value: `${s.get('schedule.grace_hours')} h`, inline: true }] : []),
      { name: 'Modules on', value: enabled.map((m) => m.name).join(', ') || '*none*', inline: false },
    );
  const zones = COMMON_ZONES.includes(s.timezone) ? COMMON_ZONES : [s.timezone, ...COMMON_ZONES.slice(0, 24)];
  const rows: Array<ActionRowBuilder<ChannelSelectMenuBuilder> | ActionRowBuilder<StringSelectMenuBuilder>> = [
    new ActionRowBuilder<ChannelSelectMenuBuilder>().addComponents(
      new ChannelSelectMenuBuilder().setCustomId('cfg:log').setPlaceholder('Log channel').setChannelTypes(ChannelType.GuildText, ChannelType.GuildAnnouncement).setMinValues(0).setMaxValues(1),
    ),
    new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(
      new StringSelectMenuBuilder().setCustomId('cfg:tz').setPlaceholder('Time zone (others: /config set timezone)').addOptions(zones.map((z) => ({ label: z, value: z, default: z === s.timezone }))),
    ),
    new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(
      new StringSelectMenuBuilder()
        .setCustomId('cfg:mass')
        .setPlaceholder('@everyone / role pings in saved content')
        .addOptions(
          { label: 'Block @everyone and role pings', value: 'off', default: !s.get('mentions.allow_mass') },
          { label: 'Allow (authors still need Mention Everyone)', value: 'on', default: Boolean(s.get('mentions.allow_mass')) },
        ),
    ),
  ];
  if (ctx.settings.registry.get('schedule.grace_hours')) {
    rows.push(
      new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(
        new StringSelectMenuBuilder().setCustomId('cfg:grace').setPlaceholder('Late-send grace window').addOptions(GRACE.map((h) => ({ label: `Send up to ${h} h late after downtime`, value: String(h), default: s.get('schedule.grace_hours') === h }))),
      ),
    );
  }
  if (mods.length) {
    rows.push(
      new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(
        new StringSelectMenuBuilder()
          .setCustomId('cfg:modules')
          .setPlaceholder('Modules on in this server')
          .setMinValues(0)
          .setMaxValues(mods.length)
          .addOptions(mods.map((m) => ({ label: m.name, value: m.id, description: m.description.slice(0, 100), default: enabled.includes(m) }))),
      ),
    );
  }
  return { embeds: [e], components: rows };
}

const pendingResets = new Map<string, { userId: string; expires: number }>();

const config: CommandSpec = {
  replyMode: 'ephemeral',
  memberPermissions: [MG],
  permAction: 'change the settings',
  data: new SlashCommandBuilder()
    .setName('config')
    .setDescription('Server settings')
    .setContexts(InteractionContextType.Guild)
    .setDefaultMemberPermissions(MG)
    .addSubcommand((s) => s.setName('panel').setDescription('Settings menu'))
    .addSubcommand((s) => s.setName('view').setDescription('Every setting and its value'))
    .addSubcommand((s) =>
      s
        .setName('set')
        .setDescription('Change one setting')
        .addStringOption((o) => o.setName('key').setDescription('Setting').setRequired(true).setAutocomplete(true))
        .addStringOption((o) => o.setName('value').setDescription('New value').setRequired(true)),
    )
    .addSubcommand((s) => s.setName('unset').setDescription('Reset one setting to its default').addStringOption((o) => o.setName('key').setDescription('Setting').setRequired(true).setAutocomplete(true)))
    .addSubcommand((s) => s.setName('export').setDescription('Download everything stored for this server (JSON)'))
    .addSubcommand((s) => s.setName('reset-data').setDescription('Delete everything stored for this server'))
    .toJSON(),
  async autocomplete(i, ctx) {
    const typed = i.options.getFocused().toLowerCase();
    await i.respond(ctx.settings.registry.visible().filter((d) => d.key.includes(typed)).slice(0, 25).map((d) => ({ name: `${d.key}: ${d.description}`.slice(0, 100), value: d.key })));
  },
  async execute(i, ctx) {
    if (!i.isChatInputCommand()) return;
    const guildId = i.guildId!;
    const sub = i.options.getSubcommand();
    if (sub === 'panel') {
      await i.reply({ ...(await panel(ctx, guildId)), flags: MessageFlags.Ephemeral });
      return;
    }
    if (sub === 'view') {
      const s = await ctx.settings.get(guildId);
      const lines = ctx.settings.registry.visible().map((d) => `\`${d.key}\` ${d.format(s.get(d.key) as never)}`);
      await respond(i, { embeds: [embed('info').setTitle('Settings').setDescription(lines.join('\n').slice(0, 4000))] }, { ephemeral: true });
      return;
    }
    if (sub === 'set' || sub === 'unset') {
      const key = i.options.getString('key', true);
      const spec = ctx.settings.registry.get(key);
      if (!spec || spec.hidden) throw new UserError(`There’s no setting called \`${key}\`. See \`/config view\``);
      const value = sub === 'set' ? spec.parse(i.options.getString('value', true)) : undefined;
      if (key === 'log.channel' && typeof value === 'string') {
        const ch = await i.guild!.channels.fetch(value).catch(() => null);
        const me = i.guild!.members.me ?? (await i.guild!.members.fetchMe());
        if (!ch || !canPost(ch, me, true)) throw new UserError(`I can’t post embeds in <#${value}>`);
      }
      await changeSettings(ctx, guildId, i.user.id, { [key]: value });
      const now = (await ctx.settings.get(guildId)).get(key);
      await respond(i, { content: `✅ \`${key}\` is now ${spec.format(now as never)}.` }, { ephemeral: true });
      return;
    }
    if (sub === 'export') {
      await i.deferReply({ flags: MessageFlags.Ephemeral });
      const db = ctx.db;
      const data = {
        exportedAt: new Date().toISOString(),
        guildId,
        settings: await db.selectFrom('guild_setting').selectAll().where('guild_id', '=', guildId).execute(),
        autoResponses: await db.selectFrom('auto_response').selectAll().where('guild_id', '=', guildId).execute(),
        scheduledMessages: await db.selectFrom('scheduled_message').selectAll().where('guild_id', '=', guildId).execute(),
        channelLocks: await db.selectFrom('channel_lock').selectAll().where('guild_id', '=', guildId).execute(),
        channelLockOverrides: await db.selectFrom('channel_lock_override').selectAll().where('guild_id', '=', guildId).execute(),
        auditLog: await db.selectFrom('audit_log').selectAll().where('guild_id', '=', guildId).orderBy('at').execute(),
        modules: {} as Record<string, unknown>,
      };
      for (const m of ctx.modules) if (m.exportData) data.modules[m.id] = await m.exportData(guildId, ctx);
      await respond(i, { content: 'Here’s everything stored for this server.', files: [new AttachmentBuilder(Buffer.from(JSON.stringify(data, null, 2)), { name: `server-${guildId}.json` })] });
      return;
    }
    const nonce = randomBytes(5).toString('hex');
    pendingResets.set(nonce, { userId: i.user.id, expires: Date.now() + 5 * 60_000 });
    const row = new ActionRowBuilder<ButtonBuilder>().addComponents(
      new ButtonBuilder().setCustomId(`cfg:reset:${nonce}`).setLabel('Delete everything').setStyle(ButtonStyle.Danger),
      new ButtonBuilder().setCustomId(`cfg:cancel:${nonce}`).setLabel('Cancel').setStyle(ButtonStyle.Secondary),
    );
    await i.reply({
      content: 'This deletes **all** settings, auto-responses, scheduled messages, lock records and the audit history for this server. Locked channels will stay locked; unlock them first. Continue?',
      components: [row],
      flags: MessageFlags.Ephemeral,
    });
  },
};

const panelComponent: ComponentSpec = {
  prefix: 'cfg',
  memberPermissions: [MG],
  async handle(raw, ctx, [field, nonce = '']) {
    const i = raw as MessageComponentInteraction;
    const guildId = i.guildId!;
    if (field === 'reset' || field === 'cancel') {
      const p = pendingResets.get(nonce);
      pendingResets.delete(nonce);
      if (field === 'cancel') return void (await i.update({ content: 'Cancelled.', components: [] }));
      if (!p || p.expires < Date.now() || p.userId !== i.user.id) return void (await i.update({ content: 'That confirmation expired.', components: [] }));
      await ctx.guilds.deleteAll(guildId, true);
      ctx.settings.invalidate(guildId);
      await ctx.audit.record({ guildId, actorId: i.user.id, action: 'config.reset-data' });
      ctx.kickWorker();
      await i.update({ content: '🧹 All data for this server was deleted.', components: [] });
      return;
    }
    const values = 'values' in i ? (i.values as string[]) : [];
    const patch: Record<string, SettingValue | undefined> = {};
    if (field === 'log') {
      if (values[0]) {
        const ch = await i.guild!.channels.fetch(values[0]).catch(() => null);
        const me = i.guild!.members.me ?? (await i.guild!.members.fetchMe());
        if (!ch || !canPost(ch, me, true)) throw new UserError(`I can’t post embeds in <#${values[0]}>`);
      }
      patch['log.channel'] = values[0] ?? undefined;
    }
    if (field === 'tz') patch.timezone = values[0];
    if (field === 'mass') patch['mentions.allow_mass'] = values[0] === 'on';
    if (field === 'grace') patch['schedule.grace_hours'] = Number(values[0]);
    if (field === 'modules') for (const m of optional(ctx)) patch[`module.${m.id}.enabled`] = values.includes(m.id);
    await changeSettings(ctx, guildId, i.user.id, patch);
    await i.update(await panel(ctx, guildId));
  },
};

const ACTION_COLORS: Record<string, keyof typeof import('../../variant.ts').variant.colors> = { lock: 'warn', unlock: 'ok', purge: 'warn', 'schedule.failed': 'error', 'config.reset-data': 'error' };

export const configModule: Module = {
  id: 'config',
  name: 'Settings',
  description: 'Server settings, audit log, data export and reset',
  required: true,
  commands: [config],
  components: [panelComponent],
  jobs: {
    'audit.post': async (job, ctx) => {
      const row = await ctx.audit.get(String(job.payload.auditId));
      if (!row) return;
      const s = await ctx.settings.get(row.guild_id);
      if (!s.logChannel) return;
      const guild = await ctx.client.guilds.fetch(row.guild_id).catch(() => null);
      const channel = guild ? await guild.channels.fetch(s.logChannel).catch(() => null) : null;
      if (!guild || !channel?.isSendable()) return;
      const me = guild.members.me ?? (await guild.members.fetchMe());
      if (!canPost(channel, me, true)) return;
      const payload = JSON.parse(row.payload_json) as Record<string, unknown>;
      const target = row.target ? (/^\d{15,22}$/.test(row.target) ? `<#${row.target}>` : `\`${row.target}\``) : null;
      const details = Object.entries(payload)
        .filter(([, v]) => v !== null && v !== undefined && !(Array.isArray(v) && !v.length))
        .map(([k, v]) => `**${k}:** ${typeof v === 'object' ? `\`${JSON.stringify(v).slice(0, 200)}\`` : String(v).slice(0, 200)}`);
      const e = embed(ACTION_COLORS[row.action] ?? 'info')
        .setTitle(`📋 ${row.action}`)
        .setDescription([`**By:** <@${row.actor_id}>`, target ? `**Target:** ${target}` : '', ...details].filter(Boolean).join('\n').slice(0, 4000))
        .setTimestamp(new Date(row.at));
      await channel.send({ embeds: [e], allowedMentions: { parse: [] } });
    },
  },
  periodic: [
    {
      name: 'purge-departed-guilds',
      intervalMs: 24 * 3_600_000,
      initialDelayMs: 10 * 60_000,
      async run(ctx) {
        const purged = await ctx.guilds.purgeGone(ctx.config.GUILD_DATA_GRACE_DAYS);
        if (purged.length) ctx.log.info({ guilds: purged }, 'purged data for departed guilds');
        await ctx.jobs.prune(14);
      },
    },
  ],
};
