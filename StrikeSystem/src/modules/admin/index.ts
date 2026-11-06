import { rm } from 'node:fs/promises';
import { join } from 'node:path';
import {
  ActionRowBuilder,
  ApplicationCommandOptionType,
  ApplicationCommandType,
  AttachmentBuilder,
  ChannelSelectMenuBuilder,
  ChannelType,
  EmbedBuilder,
  InteractionContextType,
  type MessageComponentInteraction,
  MessageFlags,
  PermissionFlagsBits,
  RoleSelectMenuBuilder,
  SlashCommandBuilder,
  StringSelectMenuBuilder,
} from 'discord.js';
import type { Case } from '../../core/cases.ts';
import { formatDuration } from '../../core/duration.ts';
import { UserError } from '../../core/errors.ts';
import { formatLadder, GRADUATED_LADDER, GRADUATED_MAX, LEGACY_LADDER } from '../../core/escalation.ts';
import { tierAllows, type Tier } from '../../core/permissions.ts';
import type { SettingValue } from '../../core/settings.ts';
import { askConfirmation } from '../../discord/confirm.ts';
import type { BotContext } from '../../discord/context.ts';
import { deliverCaseLog, sendCaseDm } from '../../discord/delivery.ts';
import { deleteEvidence } from '../../discord/evidence.ts';
import { interactionTier } from '../../discord/members.ts';
import { COLORS, ok, respond } from '../../discord/replies.ts';
import type { CommandSpec, ComponentSpec, Module } from '../types.ts';

export async function changeSettings(ctx: BotContext, guildId: string, actorId: string, patch: Record<string, SettingValue | undefined>) {
  const before = await ctx.settings.update(guildId, patch);
  const after = await ctx.settings.get(guildId);
  for (const key of Object.keys(patch)) {
    const def = ctx.settings.registry.get(key);
    const fmt = (v: SettingValue) => (def ? def.format(v as never) : JSON.stringify(v));
    await ctx.cases.create({
      guildId,
      type: 'CONFIG_CHANGE',
      targetId: null,
      actorId,
      metadata: { key, from: fmt(before[key] ?? null), to: fmt(after.get(key)) },
    });
  }
  ctx.kickWorker();
}

const TIER_ORDER: Tier[] = ['public', 'mod', 'admin'];

const help: CommandSpec = {
  tier: 'public',
  allowInMaintenance: true,
  data: new SlashCommandBuilder()
    .setName('help')
    .setDescription('Commands you can use here')
    .setContexts(InteractionContextType.Guild)
    .addStringOption((o) => o.setName('command').setDescription('Details for one command').setAutocomplete(true))
    .toJSON(),
  async autocomplete(i, ctx) {
    const typed = i.options.getFocused().toLowerCase();
    const names = ctx.commandList().filter((c) => (c.spec.data.type ?? 1) === ApplicationCommandType.ChatInput).map((c) => c.spec.data.name);
    await i.respond(names.filter((n) => n.includes(typed)).slice(0, 25).map((n) => ({ name: `/${n}`, value: n })));
  },
  async execute(i, ctx) {
    if (!i.isChatInputCommand()) return;
    const settings = await ctx.settings.get(i.guildId!);
    const tier = interactionTier(i, settings);
    const usable = [];
    for (const c of ctx.commandList()) {
      if (c.spec.ownerOnly ? !ctx.owners.has(i.user.id) : !tierAllows(tier, c.spec.tier)) continue;
      if (!(await ctx.isModuleEnabled(i.guildId!, c.module.id))) continue;
      usable.push(c);
    }
    const wanted = i.options.getString('command');
    if (wanted) {
      const c = usable.find((u) => u.spec.data.name === wanted);
      if (!c) throw new UserError(`You can't use \`/${wanted}\` here, or it doesn't exist.`);
      const d = c.spec.data as { name: string; description?: string; options?: Array<{ name: string; description: string; type: number; required?: boolean; options?: Array<{ name: string; description: string; required?: boolean }> }> };
      const lines = (d.options ?? []).flatMap((o) =>
        o.type === ApplicationCommandOptionType.Subcommand
          ? [`**/${d.name} ${o.name}**: ${o.description}${(o.options ?? []).map((x) => `\n  • \`${x.name}\`${x.required ? '' : ' (optional)'}: ${x.description}`).join('')}`]
          : [`• \`${o.name}\`${o.required ? '' : ' (optional)'}: ${o.description}`],
      );
      const embed = new EmbedBuilder().setColor(COLORS.info).setTitle(`/${d.name}`).setDescription(`${d.description ?? ''}\n\n${lines.join('\n')}`.slice(0, 4000)).setFooter({ text: `Module: ${c.module.name} · Needs: ${c.spec.ownerOnly ? 'bot owner' : c.spec.tier}` });
      await i.reply({ embeds: [embed], flags: MessageFlags.Ephemeral });
      return;
    }
    const embed = new EmbedBuilder().setColor(COLORS.info).setTitle('Commands you can use');
    for (const t of TIER_ORDER) {
      const list = usable.filter((u) => u.spec.tier === t && !u.spec.ownerOnly);
      if (!list.length) continue;
      const text = list
        .map((u) => (u.spec.data.type ?? 1) === ApplicationCommandType.ChatInput ? `\`/${u.spec.data.name}\` ${'description' in u.spec.data ? u.spec.data.description : ''}` : `*${u.spec.data.name}* (right-click menu)`)
        .join('\n');
      embed.addFields({ name: { public: 'Everyone', mod: 'Moderators', admin: 'Admins' }[t], value: text.slice(0, 1024) });
    }
    embed.setFooter({ text: '/help command:<name> for details' });
    await i.reply({ embeds: [embed], flags: MessageFlags.Ephemeral });
  },
};

const config: CommandSpec = {
  tier: 'admin',
  data: new SlashCommandBuilder()
    .setName('config')
    .setDescription('View or change this server’s settings')
    .setContexts(InteractionContextType.Guild)
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild)
    .addSubcommand((s) => s.setName('view').setDescription('Show every setting'))
    .addSubcommand((s) =>
      s
        .setName('set')
        .setDescription('Change one setting')
        .addStringOption((o) => o.setName('key').setDescription('Setting').setRequired(true).setAutocomplete(true))
        .addStringOption((o) => o.setName('value').setDescription('New value (mentions or IDs for channels and roles)').setRequired(true)),
    )
    .addSubcommand((s) => s.setName('reset').setDescription('Reset one setting to its default').addStringOption((o) => o.setName('key').setDescription('Setting').setRequired(true).setAutocomplete(true)))
    .toJSON(),
  async autocomplete(i, ctx) {
    const typed = i.options.getFocused().toLowerCase();
    const defs = ctx.settings.registry.visible().filter((d) => d.key.includes(typed));
    await i.respond(defs.slice(0, 25).map((d) => ({ name: `${d.key}: ${d.description}`.slice(0, 100), value: d.key })));
  },
  async execute(i, ctx) {
    if (!i.isChatInputCommand()) return;
    await i.deferReply({ flags: MessageFlags.Ephemeral });
    const guildId = i.guildId!;
    const sub = i.options.getSubcommand();
    if (sub === 'view') {
      const s = await ctx.settings.get(guildId);
      const lines = ctx.settings.registry.visible().map((d) => `\`${d.key}\` ${d.format(s.get(d.key) as never)}`);
      const embed = new EmbedBuilder().setColor(COLORS.info).setTitle('Settings').setDescription(lines.join('\n').slice(0, 4000)).setFooter({ text: '/config set <key> <value> · /config reset <key> · /setup for a guided setup' });
      await respond(i, { embeds: [embed] });
      return;
    }
    const key = i.options.getString('key', true);
    const def = ctx.settings.registry.get(key);
    if (!def || def.hidden) throw new UserError(`There's no setting called \`${key}\`. See \`/config view\`.`);
    const value = sub === 'set' ? def.parse(i.options.getString('value', true)) : undefined;
    await changeSettings(ctx, guildId, i.user.id, { [key]: value });
    const now = (await ctx.settings.get(guildId)).get(key);
    let note = '';
    if (key === 'mute.mode' && now === 'role' && !(await ctx.settings.get(guildId)).get('mute.role')) note = '\n⚠️ Set `mute.role` too, or timeouts will fail.';
    if (key === 'strikes.expiry') note = '\nThis applies to new strikes; existing strikes keep their expiry.';
    await respond(i, { content: ok(`\`${key}\` is now ${def.format(now as never)}.${note}`) });
  },
};

async function setupView(ctx: BotContext, guildId: string) {
  const s = await ctx.settings.get(guildId);
  const ladder = formatLadder(s.ladder);
  const preset = ladder === formatLadder(LEGACY_LADDER) ? 'legacy' : ladder === formatLadder(GRADUATED_LADDER) ? 'graduated' : 'custom';
  const embed = new EmbedBuilder()
    .setColor(COLORS.info)
    .setTitle('⚙️ Setup')
    .setDescription('Pick from the menus below. Each change is saved right away and nothing you don’t touch is changed.')
    .addFields(
      { name: 'Log channel', value: s.logChannel ? `<#${s.logChannel}>` : '*not set*', inline: true },
      { name: 'Tracker channel', value: s.get<string | null>('log.tracker_channel') ? `<#${s.get('log.tracker_channel')}>` : '*same as log*', inline: true },
      { name: 'Mod roles', value: s.get<string[]>('perms.mod_roles').map((r) => `<@&${r}>`).join(' ') || `*anyone with ${s.get('perms.fallback_permission')}*`, inline: true },
      { name: 'Max strikes', value: String(s.maxStrikes), inline: true },
      { name: 'Escalation', value: `${preset}: \`${ladder}\``, inline: true },
    );
  const textChannels = [ChannelType.GuildText, ChannelType.GuildAnnouncement];
  const rows = [
    new ActionRowBuilder<ChannelSelectMenuBuilder>().addComponents(new ChannelSelectMenuBuilder().setCustomId('setup:log').setPlaceholder('Log channel').setChannelTypes(...textChannels).setMinValues(1).setMaxValues(1)),
    new ActionRowBuilder<ChannelSelectMenuBuilder>().addComponents(new ChannelSelectMenuBuilder().setCustomId('setup:tracker').setPlaceholder('Tracker channel (a dedicated one is best)').setChannelTypes(...textChannels).setMinValues(0).setMaxValues(1)),
    new ActionRowBuilder<RoleSelectMenuBuilder>().addComponents(new RoleSelectMenuBuilder().setCustomId('setup:mods').setPlaceholder('Moderator roles (none = fallback permission)').setMinValues(0).setMaxValues(10)),
    new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(
      new StringSelectMenuBuilder()
        .setCustomId('setup:max')
        .setPlaceholder(`Max strikes (now ${s.maxStrikes})`)
        .addOptions(Array.from({ length: 10 }, (_, n) => ({ label: `${n + 1} strikes`, value: String(n + 1), default: s.maxStrikes === n + 1 }))),
    ),
    new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(
      new StringSelectMenuBuilder()
        .setCustomId('setup:preset')
        .setPlaceholder('Escalation preset')
        .addOptions(
          { label: 'Ban at max strikes (classic)', value: 'legacy', default: preset === 'legacy' },
          { label: 'Graduated: 1h timeout -> 24h timeout -> ban at 4', value: 'graduated', default: preset === 'graduated' },
        ),
    ),
  ];
  return { embeds: [embed], components: rows };
}

const setup: CommandSpec = {
  tier: 'admin',
  data: new SlashCommandBuilder()
    .setName('setup')
    .setDescription('Guided setup: log channel, tracker, mod roles, strikes and escalation')
    .setContexts(InteractionContextType.Guild)
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild)
    .toJSON(),
  async execute(i, ctx) {
    await i.reply({ ...(await setupView(ctx, i.guildId!)), flags: MessageFlags.Ephemeral });
  },
};

const setupComponent: ComponentSpec = {
  prefix: 'setup',
  tier: 'admin',
  async handle(i, ctx, [field]) {
    const c = i as MessageComponentInteraction;
    const guildId = c.guildId!;
    const values = 'values' in c ? (c.values as string[]) : [];
    const patch: Record<string, SettingValue | undefined> = {};
    if (field === 'log') patch['log.channel'] = values[0] ?? null;
    if (field === 'tracker') patch['log.tracker_channel'] = values[0] ?? undefined;
    if (field === 'mods') patch['perms.mod_roles'] = values;
    if (field === 'max') patch['strikes.max'] = Number(values[0]);
    if (field === 'preset') {
      if (values[0] === 'graduated') {
        patch['strikes.escalation'] = GRADUATED_LADDER;
        patch['strikes.max'] = GRADUATED_MAX;
      } else {
        patch['strikes.escalation'] = LEGACY_LADDER;
      }
    }
    await changeSettings(ctx, guildId, c.user.id, patch);
    await c.update(await setupView(ctx, guildId));
  },
};

const modulesCmd: CommandSpec = {
  tier: 'admin',
  data: new SlashCommandBuilder()
    .setName('modules')
    .setDescription('Turn optional features on or off for this server')
    .setContexts(InteractionContextType.Guild)
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild)
    .addSubcommand((s) => s.setName('list').setDescription('Show modules and whether they are on'))
    .addSubcommand((s) => s.setName('enable').setDescription('Turn a module on').addStringOption((o) => o.setName('module').setDescription('Module').setRequired(true).setAutocomplete(true)))
    .addSubcommand((s) => s.setName('disable').setDescription('Turn a module off').addStringOption((o) => o.setName('module').setDescription('Module').setRequired(true).setAutocomplete(true)))
    .toJSON(),
  async autocomplete(i, ctx) {
    await i.respond(ctx.modules.filter((m) => !m.required).map((m) => ({ name: m.name, value: m.id })));
  },
  async execute(i, ctx) {
    if (!i.isChatInputCommand()) return;
    await i.deferReply({ flags: MessageFlags.Ephemeral });
    const guildId = i.guildId!;
    const disabled = new Set((await ctx.settings.get(guildId)).get<string[]>('modules.disabled'));
    const sub = i.options.getSubcommand();
    if (sub === 'list') {
      const lines = ctx.modules.map((m) => `${m.required ? '🔒' : disabled.has(m.id) ? '⚪' : '🟢'} **${m.name}** (\`${m.id}\`): ${m.description}`);
      await respond(i, { embeds: [new EmbedBuilder().setColor(COLORS.info).setTitle('Modules').setDescription(lines.join('\n')).setFooter({ text: '🔒 always on · 🟢 on · ⚪ off' })] });
      return;
    }
    const id = i.options.getString('module', true);
    const m = ctx.modules.find((x) => x.id === id);
    if (!m) throw new UserError(`There's no module called \`${id}\`.`);
    if (m.required) throw new UserError(`**${m.name}** is part of the core and can't be turned off.`);
    if (sub === 'enable') disabled.delete(id);
    else disabled.add(id);
    await changeSettings(ctx, guildId, i.user.id, { 'modules.disabled': [...disabled] });
    await respond(i, { content: ok(`**${m.name}** is now ${sub === 'enable' ? 'on' : 'off'}.`) });
  },
};

const csvCell = (v: unknown) => {
  const s = v === null || v === undefined ? '' : String(v);
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
};

const exportCmd: CommandSpec = {
  tier: 'admin',
  data: new SlashCommandBuilder()
    .setName('export')
    .setDescription('Download moderation data')
    .setContexts(InteractionContextType.Guild)
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild)
    .addSubcommand((s) =>
      s
        .setName('cases')
        .setDescription('All cases, or one user’s')
        .addUserOption((o) => o.setName('user').setDescription('Only this user'))
        .addStringOption((o) => o.setName('format').setDescription('File format').addChoices({ name: 'CSV', value: 'csv' }, { name: 'JSON', value: 'json' })),
    )
    .toJSON(),
  async execute(i, ctx) {
    if (!i.isChatInputCommand()) return;
    await i.deferReply({ flags: MessageFlags.Ephemeral });
    const user = i.options.getUser('user');
    const format = i.options.getString('format') ?? 'csv';
    const { cases } = await ctx.cases.list(i.guildId!, { ...(user ? { targetId: user.id } : {}), limit: 100_000 });
    const cols: Array<keyof Case> = ['number', 'type', 'targetId', 'actorId', 'reason', 'createdAt', 'expiresAt', 'durationS', 'status', 'revokedBy', 'revokedAt', 'revokeReason', 'parentCase', 'dmStatus'];
    const body =
      format === 'json'
        ? JSON.stringify(cases.map((c) => ({ ...c, evidence: c.evidence.map(({ path: _p, ...e }) => e) })), null, 2)
        : [cols.join(','), ...cases.map((c) => cols.map((k) => csvCell(c[k])).join(','))].join('\n');
    const name = `cases-${i.guildId}${user ? `-${user.id}` : ''}.${format}`;
    await respond(i, { content: `${cases.length} case${cases.length === 1 ? '' : 's'}.`, files: [new AttachmentBuilder(Buffer.from(body, 'utf8'), { name })] });
  },
};

const purgeUserData: CommandSpec = {
  tier: 'admin',
  data: new SlashCommandBuilder()
    .setName('purge-user-data')
    .setDescription('Delete everything stored about a user in this server (data-deletion requests)')
    .setContexts(InteractionContextType.Guild)
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild)
    .addStringOption((o) => o.setName('user_id').setDescription('The user’s ID').setRequired(true).setMinLength(15).setMaxLength(22))
    .toJSON(),
  async execute(i, ctx) {
    if (!i.isChatInputCommand()) return;
    const userId = i.options.getString('user_id', true).trim();
    if (!/^\d{15,22}$/.test(userId)) throw new UserError('That isn’t a user ID.');
    const guildId = i.guildId!;
    await askConfirmation(
      i,
      `This permanently deletes every case, watchlist entry and modmail conversation about \`${userId}\` in this server, and removes their name from cases they handled. It can't be undone.`,
      async (b) => {
        const { cases } = await ctx.cases.list(guildId, { targetId: userId, limit: 100_000 });
        for (const c of cases) await deleteEvidence(c.evidence);
        const r = await ctx.cases.purgeUser(guildId, userId);
        let other = 0;
        for (const m of ctx.modules) other += (await m.purgeUser?.(guildId, userId, ctx)) ?? 0;
        await ctx.cases.create({ guildId, type: 'DATA_PURGE', targetId: null, actorId: b.user.id, reason: 'Data-deletion request', metadata: { casesDeleted: r.deleted, casesAnonymised: r.anonymised, otherRecords: other } });
        ctx.kickWorker();
        await b.editReply({ content: ok(`Done: ${r.deleted} cases deleted, ${r.anonymised} anonymised, ${other} other records removed.`), components: [] });
      },
      'Delete everything',
    );
  },
};

const botadmin: CommandSpec = {
  tier: 'admin',
  ownerOnly: true,
  allowInMaintenance: true,
  data: new SlashCommandBuilder()
    .setName('botadmin')
    .setDescription('Bot owner tools')
    .setContexts(InteractionContextType.Guild)
    .setDefaultMemberPermissions(PermissionFlagsBits.Administrator)
    .addSubcommand((s) => s.setName('status').setDescription('Health and numbers'))
    .addSubcommand((s) =>
      s
        .setName('maintenance')
        .setDescription('Reject new moderation actions with a notice')
        .addBooleanOption((o) => o.setName('on').setDescription('On or off').setRequired(true))
        .addStringOption((o) => o.setName('message').setDescription('Shown to moderators').setMaxLength(300)),
    )
    .toJSON(),
  async execute(i, ctx) {
    if (!i.isChatInputCommand()) return;
    await i.deferReply({ flags: MessageFlags.Ephemeral });
    if (i.options.getSubcommand() === 'maintenance') {
      ctx.maintenance.on = i.options.getBoolean('on', true);
      ctx.maintenance.message = i.options.getString('message') ?? 'The bot is in maintenance mode. Please try again shortly.';
      await ctx.db
        .insertInto('meta')
        .values({ key: 'maintenance', value: JSON.stringify(ctx.maintenance) })
        .onConflict((oc) => oc.column('key').doUpdateSet({ value: JSON.stringify(ctx.maintenance) }))
        .execute();
      await respond(i, { content: ok(`Maintenance mode is ${ctx.maintenance.on ? 'on' : 'off'}.`) });
      return;
    }
    const backlog = await ctx.jobs.backlog();
    const cases = await ctx.db.selectFrom('cases').select((eb) => eb.fn.countAll<number>().as('n')).executeTakeFirstOrThrow();
    const embed = new EmbedBuilder()
      .setColor(COLORS.owner)
      .setTitle('Bot status')
      .addFields(
        { name: 'Version', value: ctx.version, inline: true },
        { name: 'Uptime', value: formatDuration(Math.floor((Date.now() - ctx.startedAt.getTime()) / 1000)), inline: true },
        { name: 'Gateway ping', value: `${Math.round(ctx.client.ws.ping)} ms`, inline: true },
        { name: 'Servers', value: String(ctx.client.guilds.cache.size), inline: true },
        { name: 'Cases', value: String(cases.n), inline: true },
        { name: 'Jobs', value: `${backlog.pending} pending · ${backlog.failed} failed`, inline: true },
        { name: 'Maintenance', value: ctx.maintenance.on ? 'on' : 'off', inline: true },
        { name: 'Memory', value: `${Math.round(process.memoryUsage().rss / 1_048_576)} MB`, inline: true },
      );
    await respond(i, { embeds: [embed] });
  },
};

export const coreModule: Module = {
  id: 'core',
  name: 'Core',
  description: 'Help, settings, setup, modules, export and privacy tools',
  required: true,
  commands: [help, config, setup, modulesCmd, exportCmd, purgeUserData, botadmin],
  components: [setupComponent],
  jobs: {
    'case.log': async (job, ctx) => {
      const c = await ctx.cases.byId(String(job.payload.caseId));
      if (c) await deliverCaseLog(ctx, c);
    },
    'case.dm': async (job, ctx) => {
      const c = await ctx.cases.byId(String(job.payload.caseId));
      if (!c || c.dmStatus !== 'PENDING') return;
      const guild = await ctx.client.guilds.fetch(c.guildId).catch(() => null);
      if (!guild) return;
      const status = await sendCaseDm(ctx, c, guild.name);
      await ctx.cases.setDmStatus(c.id, status);
      if (c.logMessageId) await ctx.jobs.enqueue([{ type: 'case.log', guildId: c.guildId, payload: { caseId: c.id } }]);
    },
    'guild.purge': async (job, ctx) => {
      const guildId = job.guildId!;
      const row = await ctx.db.selectFrom('guild').select('left_at').where('guild_id', '=', guildId).executeTakeFirst();
      if (!row?.left_at) return;
      for (const m of ctx.modules) await m.purgeGuild?.(guildId, ctx);
      await ctx.db.deleteFrom('cases').where('guild_id', '=', guildId).execute();
      await ctx.db.deleteFrom('escalation_marker').where('guild_id', '=', guildId).execute();
      await ctx.db.deleteFrom('guild_settings').where('guild_id', '=', guildId).execute();
      await ctx.db.deleteFrom('jobs').where('guild_id', '=', guildId).where('status', '!=', 'running').execute();
      await ctx.db.deleteFrom('guild').where('guild_id', '=', guildId).execute();
      ctx.settings.invalidate(guildId);
      await rm(join(ctx.config.evidenceDir, guildId), { recursive: true, force: true });
      await rm(join(ctx.config.evidenceDir, 'modmail', guildId), { recursive: true, force: true });
      ctx.log.info({ guildId }, 'guild data purged after grace period');
    },
  },
  periodic: [
    {
      name: 'prune-jobs',
      intervalMs: 24 * 3_600_000,
      initialDelayMs: 15 * 60_000,
      run: (ctx) => ctx.jobs.prune(14),
    },
  ],
};
