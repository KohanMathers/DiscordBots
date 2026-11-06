import { randomUUID } from 'node:crypto';
import {
  ActionRowBuilder,
  AttachmentBuilder,
  ChannelType,
  EmbedBuilder,
  type Guild,
  InteractionContextType,
  type Message,
  MessageFlags,
  PermissionFlagsBits,
  SlashCommandBuilder,
  StringSelectMenuBuilder,
  type ThreadChannel,
  type User,
} from 'discord.js';
import { UserError } from '../../core/errors.ts';
import { kinds } from '../../core/settings.ts';
import { discordTime } from '../../core/timestamps.ts';
import type { BotContext } from '../../discord/context.ts';
import { downloadAttachments, evidenceFiles } from '../../discord/evidence.ts';
import { fetchMember } from '../../discord/members.ts';
import { caseLine } from '../../discord/render.ts';
import { COLORS, ok, respond, sanitize } from '../../discord/replies.ts';
import type { ModmailThreadTable } from '../../storage/schema.ts';
import type { CommandSpec, Module } from '../types.ts';

type Conversation = ModmailThreadTable;

const RATE = { count: 5, windowMs: 10_000 };
const PICK_TTL_MS = 10 * 60_000;
const recent = new Map<string, number[]>();
const pendingPick = new Map<string, { messages: Message[]; guildIds: string[]; expires: number }>();

function allow(userId: string): boolean {
  const now = Date.now();
  const list = (recent.get(userId) ?? []).filter((t) => now - t < RATE.windowMs);
  list.push(now);
  recent.set(userId, list);
  return list.length <= RATE.count;
}

async function openConversations(ctx: BotContext, userId: string): Promise<Conversation[]> {
  return ctx.db.selectFrom('modmail_thread').selectAll().where('user_id', '=', userId).where('status', '=', 'open').execute();
}

async function candidateGuilds(ctx: BotContext, user: User): Promise<Guild[]> {
  const enabled = await ctx.settings.guildsWhere('modmail.enabled', true);
  const out: Guild[] = [];
  for (const id of enabled) {
    const guild = ctx.client.guilds.cache.get(id);
    if (!guild || !(await ctx.isModuleEnabled(id, 'modmail'))) continue;
    const blocked = await ctx.db.selectFrom('modmail_block').select('user_id').where('guild_id', '=', id).where('user_id', '=', user.id).executeTakeFirst();
    if (blocked) continue;
    if (await fetchMember(guild, user.id)) out.push(guild);
  }
  return out;
}

async function headerEmbed(ctx: BotContext, guild: Guild, user: User): Promise<EmbedBuilder> {
  const settings = await ctx.settings.get(guild.id);
  const member = await fetchMember(guild, user.id);
  const count = await ctx.cases.activeStrikeCount(guild.id, user.id);
  const { cases, total } = await ctx.cases.list(guild.id, { targetId: user.id, limit: 5 });
  return new EmbedBuilder()
    .setColor(COLORS.info)
    .setTitle(`📬 Modmail from ${user.username}`)
    .setThumbnail(user.displayAvatarURL())
    .setDescription(
      [
        `<@${user.id}> (\`${user.id}\`)`,
        `Account created ${discordTime(user.createdAt.toISOString(), 'R')}${member?.joinedAt ? ` · joined ${discordTime(member.joinedAt.toISOString(), 'R')}` : ''}`,
        `Active strikes **${count}/${settings.maxStrikes}** · ${total} case${total === 1 ? '' : 's'} on record`,
        '',
        cases.length ? cases.map((c) => caseLine(c, ctx.caseTypes.get(c.type), { showModerator: true, botId: ctx.client.user!.id })).join('\n') : '*No cases.*',
        '',
        'Reply with `/reply` (or `/areply` to stay anonymous). End with `/close`.',
      ].join('\n'),
    );
}

async function startConversation(ctx: BotContext, guild: Guild, user: User): Promise<Conversation> {
  const settings = await ctx.settings.get(guild.id);
  const channelId = settings.get<string | null>('modmail.channel') ?? settings.logChannel;
  const parent = channelId ? await guild.channels.fetch(channelId).catch(() => null) : null;
  if (!parent || (parent.type !== ChannelType.GuildForum && parent.type !== ChannelType.GuildText)) {
    throw new UserError(`**${guild.name}** hasn't finished setting up modmail, so I can't pass your message on yet.`);
  }
  const name = `${user.username} (${user.id})`.slice(0, 100);
  const header = await headerEmbed(ctx, guild, user);
  let thread: ThreadChannel;
  if (parent.type === ChannelType.GuildForum) {
    thread = await parent.threads.create({ name, message: { embeds: [header], allowedMentions: { parse: [] } } });
  } else {
    thread = await parent.threads.create({ name, type: ChannelType.PublicThread, autoArchiveDuration: 10080 });
    await thread.send({ embeds: [header], allowedMentions: { parse: [] } });
  }
  const conv: Conversation = {
    id: randomUUID(),
    guild_id: guild.id,
    user_id: user.id,
    thread_id: thread.id,
    status: 'open',
    created_at: ctx.clock.now().toISOString(),
    closed_at: null,
    closed_by: null,
    close_reason: null,
  };
  await ctx.db.insertInto('modmail_thread').values(conv).execute();
  await user
    .send(`📬 Your messages are now going to the staff of **${guild.name}**. They'll reply here. Anything you send in this DM is passed on until the conversation is closed.`)
    .catch(() => undefined);
  return conv;
}

async function threadOf(ctx: BotContext, conv: Conversation): Promise<ThreadChannel | null> {
  const ch = await ctx.client.channels.fetch(conv.thread_id).catch(() => null);
  if (!ch?.isThread()) return null;
  if (ch.archived) await ch.setArchived(false).catch(() => undefined);
  return ch;
}

async function forward(ctx: BotContext, conv: Conversation, message: Message): Promise<void> {
  const thread = await threadOf(ctx, conv);
  if (!thread) {
    await closeConversation(ctx, conv, ctx.client.user!.id, 'thread was deleted');
    throw new UserError('That conversation was closed by the server. Send your message again to start a new one.');
  }
  const { evidence, problems } = await downloadAttachments([...message.attachments.values()], {
    dir: `${ctx.config.evidenceDir}/modmail/${conv.guild_id}`,
    maxBytes: ctx.config.EVIDENCE_MAX_MB * 1_048_576,
  });
  const embed = new EmbedBuilder()
    .setColor(0x5865f2)
    .setAuthor({ name: message.author.username, iconURL: message.author.displayAvatarURL() })
    .setDescription(message.content ? sanitize(message.content).slice(0, 4000) : '*No text*')
    .setTimestamp(message.createdAt);
  if (problems.length) embed.addFields({ name: 'Attachments', value: problems.join('\n').slice(0, 1024) });
  await thread.send({ embeds: [embed], files: await evidenceFiles(evidence), allowedMentions: { parse: [] } });
  await ctx.db
    .insertInto('modmail_message')
    .values({
      id: randomUUID(),
      conversation_id: conv.id,
      direction: 'in',
      author_id: message.author.id,
      anonymous: 0,
      content: message.content,
      attachments: JSON.stringify(evidence.map((e) => ({ filename: e.filename, url: e.url, size: e.size }))),
      created_at: message.createdAt.toISOString(),
    })
    .execute();
  await message.react('✅').catch(() => undefined);
}

async function closeConversation(ctx: BotContext, conv: Conversation, by: string, reason: string | null) {
  await ctx.db
    .updateTable('modmail_thread')
    .set({ status: 'closed', closed_at: ctx.clock.now().toISOString(), closed_by: by, close_reason: reason })
    .where('id', '=', conv.id)
    .execute();
}

async function transcript(ctx: BotContext, conv: Conversation): Promise<AttachmentBuilder> {
  const rows = await ctx.db.selectFrom('modmail_message').selectAll().where('conversation_id', '=', conv.id).orderBy('created_at').execute();
  const lines = rows.map((r) => {
    const who = r.direction === 'in' ? `User ${r.author_id}` : `Staff ${r.author_id}${r.anonymous ? ' (anonymous)' : ''}`;
    const atts = (JSON.parse(r.attachments) as Array<{ filename?: string }>).map((a) => ` [file: ${a.filename}]`).join('');
    return `[${r.created_at}] ${who}: ${r.content}${atts}`;
  });
  const text = `Modmail transcript\nGuild ${conv.guild_id} · user ${conv.user_id} · opened ${conv.created_at}\n\n${lines.join('\n')}\n`;
  return new AttachmentBuilder(Buffer.from(text, 'utf8'), { name: `modmail-${conv.user_id}-${conv.created_at.slice(0, 10)}.txt` });
}

async function handleDm(message: Message, ctx: BotContext): Promise<void> {
  const user = message.author;
  if (!allow(user.id)) {
    if ((recent.get(user.id)?.length ?? 0) === RATE.count + 1) await message.reply('⏳ Slow down a little, please. Wait a few seconds before sending more.').catch(() => undefined);
    return;
  }
  const pick = pendingPick.get(user.id);
  if (pick && pick.expires > Date.now()) {
    pick.messages.push(message);
    return;
  }
  try {
    const open = await openConversations(ctx, user.id);
    if (open.length === 1) {
      await forward(ctx, open[0]!, message);
      return;
    }
    const guilds = open.length > 1 ? open.map((c) => ctx.client.guilds.cache.get(c.guild_id)).filter((g): g is Guild => !!g) : await candidateGuilds(ctx, user);
    if (guilds.length === 0) {
      await message.reply("👋 Hi! I can't pass messages to the staff of any server you're in right now.").catch(() => undefined);
      return;
    }
    if (guilds.length === 1) {
      const conv = open[0] ?? (await startConversation(ctx, guilds[0]!, user));
      await forward(ctx, conv, message);
      return;
    }
    pendingPick.set(user.id, { messages: [message], guildIds: guilds.map((g) => g.id), expires: Date.now() + PICK_TTL_MS });
    const menu = new StringSelectMenuBuilder()
      .setCustomId('mm:pick')
      .setPlaceholder('Choose a server')
      .addOptions(guilds.slice(0, 25).map((g) => ({ label: g.name.slice(0, 100), value: g.id })));
    await message.reply({
      content: "Which server's staff do you want to contact? Nothing is sent until you choose.",
      components: [new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(menu)],
    });
  } catch (err) {
    if (err instanceof UserError) await message.reply(err.message).catch(() => undefined);
    else throw err;
  }
}

async function requireConversation(ctx: BotContext, channelId: string): Promise<Conversation> {
  const conv = await ctx.db.selectFrom('modmail_thread').selectAll().where('thread_id', '=', channelId).where('status', '=', 'open').executeTakeFirst();
  if (!conv) throw new UserError('Use this inside an open modmail thread.');
  return conv;
}

function replyCommand(name: 'reply' | 'areply', anonymous: boolean): CommandSpec {
  return {
    tier: 'mod',
    data: new SlashCommandBuilder()
      .setName(name)
      .setDescription(anonymous ? 'Reply to the user anonymously (in a modmail thread)' : 'Reply to the user (in a modmail thread)')
      .setContexts(InteractionContextType.Guild)
      .setDefaultMemberPermissions(PermissionFlagsBits.ModerateMembers)
      .addStringOption((o) => o.setName('text').setDescription('Your reply').setRequired(true).setMaxLength(2000))
      .addAttachmentOption((o) => o.setName('attachment').setDescription('A file to send'))
      .toJSON(),
    async execute(i, ctx) {
      if (!i.isChatInputCommand()) return;
      const conv = await requireConversation(ctx, i.channelId);
      await i.deferReply();
      const text = i.options.getString('text', true);
      const att = i.options.getAttachment('attachment');
      const { evidence, problems } = await downloadAttachments(att ? [att] : [], {
        dir: `${ctx.config.evidenceDir}/modmail/${conv.guild_id}`,
        maxBytes: ctx.config.EVIDENCE_MAX_MB * 1_048_576,
      });
      const member = i.guild ? await fetchMember(i.guild, i.user.id) : null;
      const from = anonymous ? `${i.guild!.name} staff` : `${member?.displayName ?? i.user.username} (${i.guild!.name} staff)`;
      const dm = new EmbedBuilder().setColor(COLORS.ok).setAuthor({ name: from.slice(0, 256) }).setDescription(text).setTimestamp();
      try {
        const user = await ctx.client.users.fetch(conv.user_id);
        await user.send({ embeds: [dm], files: await evidenceFiles(evidence), allowedMentions: { parse: [] } });
      } catch {
        throw new UserError("I couldn't DM them. They may have closed their DMs or left every server we share.");
      }
      await ctx.db
        .insertInto('modmail_message')
        .values({
          id: randomUUID(),
          conversation_id: conv.id,
          direction: 'out',
          author_id: i.user.id,
          anonymous: anonymous ? 1 : 0,
          content: text,
          attachments: JSON.stringify(evidence.map((e) => ({ filename: e.filename, url: e.url, size: e.size }))),
          created_at: ctx.clock.now().toISOString(),
        })
        .execute();
      const echo = new EmbedBuilder()
        .setColor(COLORS.ok)
        .setAuthor({ name: `↪ ${i.user.username}${anonymous ? ' (sent anonymously)' : ''}` })
        .setDescription(text + (problems.length ? `\n\n⚠️ ${problems.join('\n')}` : ''));
      await respond(i, { embeds: [echo], files: await evidenceFiles(evidence) });
    },
  };
}

export const modmailModule: Module = {
  id: 'modmail',
  name: 'Modmail',
  description: 'Members DM the bot to talk to staff privately, in threads',
  settings: [
    { key: 'modmail.enabled', description: 'Accept modmail from members', default: false, ...kinds.bool() },
    { key: 'modmail.channel', description: 'Forum or text channel for modmail threads (default: the log channel)', default: null, ...kinds.channel() },
    { key: 'modmail.retention_days', description: 'Days to keep closed conversations and transcripts', default: 90, ...kinds.int(1, 3650) },
  ],
  migrations: {
    '0300_modmail': {
      async up(db) {
        await db.schema
          .createTable('modmail_thread')
          .addColumn('id', 'text', (c) => c.primaryKey())
          .addColumn('guild_id', 'text', (c) => c.notNull())
          .addColumn('user_id', 'text', (c) => c.notNull())
          .addColumn('thread_id', 'text', (c) => c.notNull())
          .addColumn('status', 'text', (c) => c.notNull())
          .addColumn('created_at', 'text', (c) => c.notNull())
          .addColumn('closed_at', 'text')
          .addColumn('closed_by', 'text')
          .addColumn('close_reason', 'text')
          .execute();
        await db.schema.createIndex('modmail_thread_user').on('modmail_thread').columns(['user_id', 'status']).execute();
        await db.schema.createIndex('modmail_thread_thread').on('modmail_thread').column('thread_id').execute();
        await db.schema
          .createTable('modmail_message')
          .addColumn('id', 'text', (c) => c.primaryKey())
          .addColumn('conversation_id', 'text', (c) => c.notNull().references('modmail_thread.id').onDelete('cascade'))
          .addColumn('direction', 'text', (c) => c.notNull())
          .addColumn('author_id', 'text', (c) => c.notNull())
          .addColumn('anonymous', 'integer', (c) => c.notNull().defaultTo(0))
          .addColumn('content', 'text', (c) => c.notNull())
          .addColumn('attachments', 'text', (c) => c.notNull().defaultTo('[]'))
          .addColumn('created_at', 'text', (c) => c.notNull())
          .execute();
        await db.schema
          .createTable('modmail_block')
          .addColumn('guild_id', 'text', (c) => c.notNull())
          .addColumn('user_id', 'text', (c) => c.notNull())
          .addColumn('actor_id', 'text', (c) => c.notNull())
          .addColumn('created_at', 'text', (c) => c.notNull())
          .addPrimaryKeyConstraint('modmail_block_pk', ['guild_id', 'user_id'])
          .execute();
      },
    },
  },
  events: {
    directMessage: handleDm,
    async threadDelete(thread, ctx) {
      const conv = await ctx.db.selectFrom('modmail_thread').selectAll().where('thread_id', '=', thread.id).where('status', '=', 'open').executeTakeFirst();
      if (conv) await closeConversation(ctx, conv, ctx.client.user!.id, 'thread deleted');
    },
  },
  periodic: [
    {
      name: 'modmail-retention',
      intervalMs: 24 * 3_600_000,
      initialDelayMs: 10 * 60_000,
      async run(ctx) {
        for (const row of await ctx.db.selectFrom('modmail_thread').select(['id', 'guild_id', 'closed_at']).where('status', '=', 'closed').execute()) {
          const days = (await ctx.settings.get(row.guild_id)).get<number>('modmail.retention_days');
          if (row.closed_at && Date.parse(row.closed_at) < ctx.clock.now().getTime() - days * 86_400_000) {
            await ctx.db.deleteFrom('modmail_message').where('conversation_id', '=', row.id).execute();
            await ctx.db.deleteFrom('modmail_thread').where('id', '=', row.id).execute();
          }
        }
      },
    },
  ],
  components: [
    {
      prefix: 'mm',
      tier: 'public',
      async handle(i, ctx) {
        if (!i.isStringSelectMenu()) return;
        const pick = pendingPick.get(i.user.id);
        const guildId = i.values[0] ?? '';
        if (!pick || pick.expires < Date.now() || !pick.guildIds.includes(guildId)) {
          await i.update({ content: 'That choice expired. Send your message again.', components: [] });
          return;
        }
        pendingPick.delete(i.user.id);
        const guild = ctx.client.guilds.cache.get(guildId);
        if (!guild) throw new UserError("I'm no longer in that server.");
        await i.update({ content: `Sending your message to **${guild.name}**…`, components: [] });
        const open = (await openConversations(ctx, i.user.id)).find((c) => c.guild_id === guildId);
        const conv = open ?? (await startConversation(ctx, guild, i.user));
        for (const m of pick.messages) await forward(ctx, conv, m);
      },
    },
  ],
  commands: [
    replyCommand('reply', false),
    replyCommand('areply', true),
    {
      tier: 'mod',
      data: new SlashCommandBuilder()
        .setName('close')
        .setDescription('Close this modmail conversation')
        .setContexts(InteractionContextType.Guild)
        .setDefaultMemberPermissions(PermissionFlagsBits.ModerateMembers)
        .addStringOption((o) => o.setName('reason').setDescription('Shown to the user').setMaxLength(500))
        .toJSON(),
      async execute(i, ctx) {
        if (!i.isChatInputCommand()) return;
        const conv = await requireConversation(ctx, i.channelId);
        await i.deferReply();
        const reason = i.options.getString('reason');
        await closeConversation(ctx, conv, i.user.id, reason);
        await ctx.client.users
          .send(conv.user_id, `🔒 Your conversation with **${i.guild!.name}** staff was closed${reason ? `: ${reason}` : '.'} Message me again any time to start a new one.`)
          .catch(() => undefined);
        await respond(i, { content: `🔒 Closed by <@${i.user.id}>${reason ? `: ${sanitize(reason)}` : ''}. Transcript attached.`, files: [await transcript(ctx, conv)] });
        const thread = await ctx.client.channels.fetch(conv.thread_id).catch(() => null);
        if (thread?.isThread()) {
          await thread.setLocked(true).catch(() => undefined);
          await thread.setArchived(true).catch(() => undefined);
        }
      },
    },
    {
      tier: 'mod',
      data: new SlashCommandBuilder()
        .setName('modmail')
        .setDescription('Modmail management')
        .setContexts(InteractionContextType.Guild)
        .setDefaultMemberPermissions(PermissionFlagsBits.ModerateMembers)
        .addSubcommand((s) => s.setName('block').setDescription('Stop a user from opening modmail').addUserOption((o) => o.setName('user').setDescription('User').setRequired(true)))
        .addSubcommand((s) => s.setName('unblock').setDescription('Allow a user to use modmail again').addUserOption((o) => o.setName('user').setDescription('User').setRequired(true)))
        .toJSON(),
      async execute(i, ctx) {
        if (!i.isChatInputCommand()) return;
        await i.deferReply({ flags: MessageFlags.Ephemeral });
        const user = i.options.getUser('user', true);
        if (i.options.getSubcommand() === 'block') {
          await ctx.db
            .insertInto('modmail_block')
            .values({ guild_id: i.guildId!, user_id: user.id, actor_id: i.user.id, created_at: ctx.clock.now().toISOString() })
            .orIgnore()
            .execute();
          await respond(i, { content: ok(`<@${user.id}> can no longer open modmail here.`) });
        } else {
          await ctx.db.deleteFrom('modmail_block').where('guild_id', '=', i.guildId!).where('user_id', '=', user.id).execute();
          await respond(i, { content: ok(`<@${user.id}> can use modmail again.`) });
        }
      },
    },
  ],
  async purgeGuild(guildId, ctx) {
    const convs = await ctx.db.selectFrom('modmail_thread').select('id').where('guild_id', '=', guildId).execute();
    if (convs.length) await ctx.db.deleteFrom('modmail_message').where('conversation_id', 'in', convs.map((c) => c.id)).execute();
    await ctx.db.deleteFrom('modmail_thread').where('guild_id', '=', guildId).execute();
    await ctx.db.deleteFrom('modmail_block').where('guild_id', '=', guildId).execute();
  },
  async purgeUser(guildId, userId, ctx) {
    const convs = await ctx.db.selectFrom('modmail_thread').select('id').where('guild_id', '=', guildId).where('user_id', '=', userId).execute();
    if (convs.length) await ctx.db.deleteFrom('modmail_message').where('conversation_id', 'in', convs.map((c) => c.id)).execute();
    const r = await ctx.db.deleteFrom('modmail_thread').where('guild_id', '=', guildId).where('user_id', '=', userId).executeTakeFirst();
    await ctx.db.deleteFrom('modmail_block').where('guild_id', '=', guildId).where('user_id', '=', userId).execute();
    return Number(r.numDeletedRows);
  },
};
