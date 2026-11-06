import { randomBytes } from 'node:crypto';
import {
  ActionRowBuilder,
  ApplicationCommandType,
  ButtonBuilder,
  ButtonStyle,
  ContextMenuCommandBuilder,
  InteractionContextType,
  type Message,
  MessageFlags,
  ModalBuilder,
  type ModalSubmitInteraction,
  PermissionFlagsBits,
  SlashCommandBuilder,
  StringSelectMenuBuilder,
  TextInputBuilder,
  TextInputStyle,
} from 'discord.js';
import { UserError } from '../../core/errors.ts';
import { kinds } from '../../core/settings.ts';
import { type MatchMode, matches, mentionPolicyFor } from '../../core/text.ts';
import { buildOutgoing, templateVars } from '../../discord/adapters.ts';
import { readContentModal } from '../../discord/forms.ts';
import type { BotContext } from '../../discord/context.ts';
import { embed, respond } from '../../discord/replies.ts';
import { t } from '../../messages.ts';
import { type AutoResponse, normKeyword } from '../../services/autoresponses.ts';
import type { EmbedSpec } from '../../services/schedule.ts';
import type { CommandSpec, ComponentSpec, Module } from '../types.ts';

const MM = PermissionFlagsBits.ManageMessages;
const PAGE = 15;
const MATCH_MODES: MatchMode[] = ['manual', 'exact', 'word', 'regex'];

const pendingModals = new Map<string, { kind: 'add' | 'edit'; keyword: string; match: MatchMode; userId: string; expires: number }>();

function contentModal(nonce: string, title: string, prefill?: AutoResponse) {
  const field = (id: string, label: string, style: TextInputStyle, max: number, value?: string, required = false) => {
    const input = new TextInputBuilder().setCustomId(id).setLabel(label).setStyle(style).setMaxLength(max).setRequired(required);
    if (value) input.setValue(value);
    return new ActionRowBuilder<TextInputBuilder>().addComponents(input);
  };
  return new ModalBuilder()
    .setCustomId(`ar:modal:${nonce}`)
    .setTitle(title.slice(0, 45))
    .addComponents(
      field('text', 'Response (supports {member}, {server}, …)', TextInputStyle.Paragraph, 2000, prefill?.response),
      field('title', 'Embed title (optional: sends as an embed)', TextInputStyle.Short, 256, prefill?.embed?.title),
      field('color', 'Embed colour, hex (optional)', TextInputStyle.Short, 7, prefill?.embed?.color !== undefined ? `#${prefill.embed.color.toString(16).padStart(6, '0')}` : undefined),
      field('image', 'Embed image URL (optional)', TextInputStyle.Short, 500, prefill?.embed?.image),
    );
}

const keywordAutocomplete: CommandSpec['autocomplete'] = async (i, ctx) => {
  const typed = normKeyword(i.options.getFocused());
  const list = await ctx.autoresponses.list(i.guildId!);
  await i.respond(list.filter((a) => a.keywordNorm.includes(typed)).slice(0, 25).map((a) => ({ name: a.keyword.slice(0, 100), value: a.keyword.slice(0, 100) })));
};

const passiveCache = new Map<string, { at: number; list: AutoResponse[] }>();
const invalidate = (guildId: string) => passiveCache.delete(guildId);

const autoresponse: CommandSpec = {
  replyMode: 'ephemeral',
  memberPermissions: [MM],
  permAction: 'manage autoresponses',
  data: new SlashCommandBuilder()
    .setName('autoresponse')
    .setDescription('Saved replies that moderators can send')
    .setContexts(InteractionContextType.Guild)
    .setDefaultMemberPermissions(MM)
    .addSubcommand((s) =>
      s
        .setName('add')
        .setDescription('Save a new auto-response')
        .addStringOption((o) => o.setName('keyword').setDescription('Name to send it by').setRequired(true).setMaxLength(100))
        .addStringOption((o) => o.setName('response').setDescription('The reply (leave empty for a form with multi-line text and embeds)').setMaxLength(2000))
        .addStringOption((o) =>
          o
            .setName('match')
            .setDescription('Also reply automatically when a message matches (default: manual only)')
            .addChoices(...MATCH_MODES.map((m) => ({ name: m, value: m }))),
        ),
    )
    .addSubcommand((s) => s.setName('edit').setDescription('Change an auto-response').addStringOption((o) => o.setName('keyword').setDescription('Which one').setRequired(true).setAutocomplete(true)))
    .addSubcommand((s) => s.setName('remove').setDescription('Delete an auto-response').addStringOption((o) => o.setName('keyword').setDescription('Which one').setRequired(true).setAutocomplete(true)))
    .addSubcommand((s) => s.setName('list').setDescription('All saved auto-responses').addIntegerOption((o) => o.setName('page').setDescription('Page').setMinValue(1)))
    .toJSON(),
  autocomplete: keywordAutocomplete,
  async execute(i, ctx) {
    if (!i.isChatInputCommand()) return;
    const guildId = i.guildId!;
    const sub = i.options.getSubcommand();

    if (sub === 'list') {
      const list = await ctx.autoresponses.list(guildId);
      const page = (i.options.getInteger('page') ?? 1) - 1;
      const pages = Math.max(1, Math.ceil(list.length / PAGE));
      const lines = list.slice(page * PAGE, page * PAGE + PAGE).map((a) => `• \`${a.keyword}\`${a.matchMode !== 'manual' ? ` (${a.matchMode})` : ''} · used ${a.useCount}× · ${a.response.replace(/\s+/g, ' ').slice(0, 60)}`);
      const e = embed('info').setTitle(`Auto-responses (${list.length})`).setDescription(lines.join('\n') || '*None yet. Add one with `/autoresponse add`.*').setFooter({ text: `Page ${page + 1}/${pages} · right-click a message -> Apps -> Send auto-response` });
      await respond(i, { embeds: [e] }, { ephemeral: true });
      return;
    }

    const keyword = i.options.getString('keyword', true);
    if (sub === 'remove') {
      const removed = await ctx.autoresponses.remove(guildId, i.user.id, keyword);
      invalidate(guildId);
      ctx.kickWorker();
      await respond(i, { content: t('ar.removed', { keyword: removed.keyword }) }, { ephemeral: true });
      return;
    }

    const nonce = randomBytes(5).toString('hex');
    if (sub === 'edit') {
      const existing = await ctx.autoresponses.get(guildId, keyword);
      if (!existing) throw new UserError(t('ar.missing'));
      pendingModals.set(nonce, { kind: 'edit', keyword: existing.keyword, match: existing.matchMode, userId: i.user.id, expires: Date.now() + 15 * 60_000 });
      await i.showModal(contentModal(nonce, `Edit ${existing.keyword}`, existing));
      return;
    }

    const match = (i.options.getString('match') as MatchMode | null) ?? 'manual';
    if (await ctx.autoresponses.get(guildId, keyword)) throw new UserError(t('ar.exists'));
    const response = i.options.getString('response');
    if (!response) {
      pendingModals.set(nonce, { kind: 'add', keyword, match, userId: i.user.id, expires: Date.now() + 15 * 60_000 });
      await i.showModal(contentModal(nonce, `New: ${keyword}`));
      return;
    }
    await saveAdd(i, ctx, keyword, match, response, null);
  },
};

async function saveAdd(i: Parameters<CommandSpec['execute']>[0] | ModalSubmitInteraction, ctx: BotContext, keyword: string, match: MatchMode, text: string, e: EmbedSpec | null) {
  const guildId = i.guildId!;
  const settings = await ctx.settings.get(guildId);
  const mentions = mentionPolicyFor(`${text} ${e?.title ?? ''}`, {
    authorCanMentionEveryone: Boolean(i.memberPermissions?.has(PermissionFlagsBits.MentionEveryone)),
    guildAllowsMass: settings.get<boolean>('mentions.allow_mass'),
  });
  await ctx.autoresponses.add(guildId, i.user.id, { keyword, response: text, embed: e, matchMode: match, mentions });
  invalidate(guildId);
  ctx.kickWorker();
  const note = match !== 'manual' && !ctx.config.ENABLE_MESSAGE_CONTENT ? `\n⚠️ Automatic \`${match}\` matching needs the Message Content intent, which this bot runs without, so it only works manually for now.` : '';
  await respond(i, { content: `${t('ar.added', { keyword, response: text.length > 300 ? `${text.slice(0, 300)}…` : text || '*(embed)*' })}${note}` }, { ephemeral: true });
}

async function sendTo(ctx: BotContext, channelId: string, messageId: string, guildId: string, keyword: string): Promise<string> {
  const ar = await ctx.autoresponses.get(guildId, keyword);
  if (!ar) throw new UserError(t('ar.notFound'));
  const guild = await ctx.client.guilds.fetch(guildId);
  const channel = await guild.channels.fetch(channelId).catch(() => null);
  const target = channel?.isTextBased() ? await channel.messages.fetch(messageId).catch(() => null) : null;
  if (!target) throw new UserError('That message is gone');
  const member = target.member ?? (await guild.members.fetch(target.author.id).catch(() => null));
  const out = buildOutgoing(ar.response, ar.embed, ar.mentions, templateVars({ guild, channelId, member }));
  await target.reply({ ...out, allowedMentions: { ...out.allowedMentions, repliedUser: true } });
  await ctx.autoresponses.recordUse(guildId, ar.keywordNorm);
  return ar.keyword;
}

const sendMenu: CommandSpec = {
  replyMode: 'ephemeral',
  memberPermissions: [MM],
  permAction: 'use autoresponses',
  botPermissions: [PermissionFlagsBits.SendMessages, PermissionFlagsBits.ReadMessageHistory],
  data: new ContextMenuCommandBuilder().setName('Send auto-response').setType(ApplicationCommandType.Message).setContexts(InteractionContextType.Guild).setDefaultMemberPermissions(MM).toJSON(),
  async execute(i, ctx) {
    if (!i.isMessageContextMenuCommand()) return;
    const list = await ctx.autoresponses.list(i.guildId!);
    if (!list.length) throw new UserError('There are no auto-responses yet. Add one with `/autoresponse add`');
    const id = `${i.channelId}:${i.targetId}`;
    const rows: Array<ActionRowBuilder<StringSelectMenuBuilder> | ActionRowBuilder<ButtonBuilder>> = [
      new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(
        new StringSelectMenuBuilder()
          .setCustomId(`ar:send:${id}`)
          .setPlaceholder('Pick an auto-response')
          .addOptions(list.slice(0, 25).map((a) => ({ label: a.keyword.slice(0, 100), value: a.keywordNorm.slice(0, 100), description: a.response.replace(/\s+/g, ' ').slice(0, 100) || 'embed' }))),
      ),
    ];
    if (list.length > 25) {
      rows.push(new ActionRowBuilder<ButtonBuilder>().addComponents(new ButtonBuilder().setCustomId(`ar:type:${id}`).setLabel('Type a keyword…').setStyle(ButtonStyle.Secondary)));
    }
    await i.reply({ content: `Reply to ${i.targetMessage.url} with:`, components: rows, flags: MessageFlags.Ephemeral });
  },
};

const components: ComponentSpec = {
  prefix: 'ar',
  memberPermissions: [MM],
  async handle(i, ctx, [kind, a = '', b = '']) {
    if (kind === 'send' && i.isStringSelectMenu()) {
      const kw = await sendTo(ctx, a, b, i.guildId!, i.values[0] ?? '');
      await i.update({ content: `Sent \`${kw}\`.`, components: [] });
      return;
    }
    if (kind === 'type' && i.isButton()) {
      const input = new TextInputBuilder().setCustomId('keyword').setLabel('Keyword').setStyle(TextInputStyle.Short).setRequired(true).setMaxLength(100);
      await i.showModal(new ModalBuilder().setCustomId(`ar:typed:${a}:${b}`).setTitle('Send auto-response').addComponents(new ActionRowBuilder<TextInputBuilder>().addComponents(input)));
      return;
    }
    if (kind === 'typed' && i.isModalSubmit()) {
      const kw = await sendTo(ctx, a, b, i.guildId!, i.fields.getTextInputValue('keyword'));
      await i.reply({ content: `Sent \`${kw}\`.`, flags: MessageFlags.Ephemeral });
      return;
    }
    if (kind === 'modal' && i.isModalSubmit()) {
      const p = pendingModals.get(a);
      pendingModals.delete(a);
      if (!p || p.expires < Date.now() || p.userId !== i.user.id) throw new UserError('That form expired. Run the command again');
      const { text, embed: e } = readContentModal(i);
      if (p.kind === 'add') {
        await saveAdd(i, ctx, p.keyword, p.match, text, e);
        return;
      }
      const settings = await ctx.settings.get(i.guildId!);
      const mentions = mentionPolicyFor(`${text} ${e?.title ?? ''}`, {
        authorCanMentionEveryone: Boolean(i.memberPermissions?.has(PermissionFlagsBits.MentionEveryone)),
        guildAllowsMass: settings.get<boolean>('mentions.allow_mass'),
      });
      await ctx.autoresponses.edit(i.guildId!, i.user.id, p.keyword, { response: text, embed: e, mentions });
      invalidate(i.guildId!);
      ctx.kickWorker();
      await i.reply({ content: `Autoresponse \`${p.keyword}\` updated.`, flags: MessageFlags.Ephemeral });
    }
  },
};

const cooldowns = new Map<string, number>();

async function onMessage(message: Message<true>, ctx: BotContext): Promise<void> {
  if (message.author.bot || !message.content) return;
  const guildId = message.guildId;
  let cached = passiveCache.get(guildId);
  if (!cached || Date.now() - cached.at > 30_000) {
    cached = { at: Date.now(), list: await ctx.autoresponses.list(guildId, { passiveOnly: true }) };
    passiveCache.set(guildId, cached);
  }
  if (!cached.list.length) return;
  const settings = await ctx.settings.get(guildId);
  const allowed = settings.get<string[]>('autoresponse.channels');
  const channelId = message.channel.isThread() ? (message.channel.parentId ?? message.channelId) : message.channelId;
  if (allowed.length && !allowed.includes(channelId)) return;
  const ar = cached.list.find((a) => {
    try {
      return matches(a.matchMode, a.keyword, message.content);
    } catch {
      return false;
    }
  });
  if (!ar) return;
  const key = `${message.channelId}:${ar.keywordNorm}`;
  const cooldownMs = settings.get<number>('autoresponse.cooldown_s') * 1000;
  if ((cooldowns.get(key) ?? 0) > Date.now()) return;
  cooldowns.set(key, Date.now() + cooldownMs);
  const out = buildOutgoing(ar.response, ar.embed, ar.mentions, templateVars({ guild: message.guild, channelId: message.channelId, member: message.member }));
  await message.reply({ ...out, allowedMentions: { ...out.allowedMentions, repliedUser: false } });
  await ctx.autoresponses.recordUse(guildId, ar.keywordNorm);
}

export const autoresponseModule: Module = {
  id: 'autoresponse',
  name: 'Auto-responses',
  description: 'Saved replies, sent by moderators or (optionally) automatically on matching messages',
  commands: [autoresponse, sendMenu],
  components: [components],
  settings: [
    { key: 'autoresponse.cooldown_s', description: 'Seconds before the same automatic reply can fire again in a channel', default: 30, ...kinds.int(0, 3600) },
    { key: 'autoresponse.channels', description: 'Channels where automatic replies may fire (empty = all)', default: [], ...kinds.channels() },
  ],
  migrations: {
    '0200_autoresponse': {
      async up(db) {
        await db.schema
          .createTable('auto_response')
          .addColumn('guild_id', 'text', (c) => c.notNull().references('guild.guild_id').onDelete('cascade'))
          .addColumn('keyword_norm', 'text', (c) => c.notNull())
          .addColumn('keyword', 'text', (c) => c.notNull())
          .addColumn('response', 'text', (c) => c.notNull())
          .addColumn('embed_json', 'text')
          .addColumn('match_mode', 'text', (c) => c.notNull().defaultTo('manual'))
          .addColumn('allowed_mentions', 'text', (c) => c.notNull())
          .addColumn('created_by', 'text', (c) => c.notNull())
          .addColumn('created_at', 'text', (c) => c.notNull())
          .addColumn('use_count', 'integer', (c) => c.notNull().defaultTo(0))
          .addPrimaryKeyConstraint('auto_response_pk', ['guild_id', 'keyword_norm'])
          .execute();
      },
    },
  },
  events: { message: onMessage },
};
