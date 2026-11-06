import { randomBytes } from 'node:crypto';
import {
  ApplicationCommandType,
  type GuildBasedChannel,
  type Interaction,
  MessageFlags,
  PermissionsBitField,
} from 'discord.js';
import { UserError } from '../core/errors.ts';
import { t } from '../messages.ts';
import type { CommandInteraction, CommandSpec, ComponentSpec, Module } from '../modules/types.ts';
import type { BotContext } from './context.ts';
import { handleInteractionError } from './replies.ts';

const key = (type: number, name: string) => `${type}:${name}`;

export const permName = (bit: bigint) =>
  (new PermissionsBitField(bit).toArray()[0] ?? 'Unknown').replace(/([a-z])([A-Z])/g, '$1 $2').replace('Moderate Members', 'Timeout Members');

export class Router {
  private readonly commands = new Map<string, { spec: CommandSpec; module: Module }>();
  private readonly components = new Map<string, { spec: ComponentSpec; module: Module }>();
  private readonly cooldowns = new Map<string, number>();

  constructor(modules: Module[]) {
    for (const module of modules) {
      for (const spec of module.commands ?? []) {
        const k = key(spec.data.type ?? ApplicationCommandType.ChatInput, spec.data.name);
        if (this.commands.has(k)) throw new Error(`command ${k} registered twice`);
        this.commands.set(k, { spec, module });
      }
      for (const spec of module.components ?? []) {
        if (this.components.has(spec.prefix)) throw new Error(`component prefix ${spec.prefix} registered twice`);
        this.components.set(spec.prefix, { spec, module });
      }
    }
  }

  all() {
    return [...this.commands.values()];
  }

  async handle(i: Interaction, ctx: BotContext): Promise<void> {
    const ref = randomBytes(4).toString('hex');
    const started = Date.now();
    let command = '';
    let outcome = 'ok';
    try {
      if (i.isAutocomplete()) {
        const r = this.commands.get(key(ApplicationCommandType.ChatInput, i.commandName));
        if (r?.spec.autocomplete && i.inGuild()) await r.spec.autocomplete(i, ctx).catch(() => i.respond([]));
        return;
      }
      if (i.isChatInputCommand() || i.isContextMenuCommand()) {
        command = i.isChatInputCommand() ? [i.commandName, i.options.getSubcommandGroup(false), i.options.getSubcommand(false)].filter(Boolean).join(' ') : i.commandName;
        const r = this.commands.get(key(i.commandType, i.commandName));
        if (!r) return;
        await this.gate(i, ctx, r.module, r.spec);
        if (r.spec.slow) await i.deferReply(r.spec.replyMode === 'ephemeral' ? { flags: MessageFlags.Ephemeral } : {});
        await r.spec.execute(i, ctx);
        return;
      }
      if (i.isMessageComponent() || i.isModalSubmit()) {
        const [prefix = '', ...args] = i.customId.split(':');
        const r = this.components.get(prefix);
        if (!r) return;
        command = `component:${prefix}`;
        if (!i.inGuild()) throw new UserError(t('error.serverOnly'));
        if (!(await ctx.isModuleEnabled(i.guildId, r.module.id))) throw new UserError(`The ${r.module.name} module is turned off in this server`);
        if (r.spec.memberPermissions?.length && !i.memberPermissions?.has(r.spec.memberPermissions)) {
          throw new UserError(t('perm.need', { perm: r.spec.memberPermissions.map(permName).join(' and '), action: 'do that' }));
        }
        await r.spec.handle(i, ctx, args);
      }
    } catch (err) {
      outcome = err instanceof UserError ? 'refused' : 'error';
      await handleInteractionError(i, err, ref, ctx.log, ctx.supportUrl());
    } finally {
      if (command) {
        const latency = Date.now() - started;
        ctx.metrics.inc('mm_commands_total', { command, outcome });
        ctx.log.info({ guild_id: i.guildId, command, actor_id: i.user.id, latency_ms: latency, outcome, correlation_id: ref }, 'command');
      }
    }
  }

  private async gate(i: CommandInteraction, ctx: BotContext, module: Module, spec: CommandSpec): Promise<void> {
    if (!i.inGuild() || !i.guild) throw new UserError(t('error.serverOnly'));
    if (!(await ctx.isModuleEnabled(i.guildId, module.id))) {
      throw new UserError(`The ${module.name} module is turned off in this server. An admin can turn it on with \`/config\``);
    }
    const channel = await targetChannel(i, spec);

    if (spec.memberPermissions?.length) {
      const perms =
        channel.id === i.channelId && i.memberPermissions
          ? i.memberPermissions
          : channel.permissionsFor(await i.guild.members.fetch(i.user.id));
      const missing = spec.memberPermissions.filter((p) => !perms?.has(p));
      if (missing.length) throw new UserError(t('perm.need', { perm: missing.map(permName).join(' and '), action: spec.permAction ?? 'use this command' }));
    }
    if (spec.botPermissions?.length) {
      const me = i.guild.members.me ?? (await i.guild.members.fetchMe());
      const perms = channel.permissionsFor(me);
      const missing = spec.botPermissions.filter((p) => !perms?.has(p));
      if (missing.length) throw new UserError(`I need **${missing.map(permName).join('**, **')}** in <#${channel.id}> to do that. Ask an admin to grant it`);
    }
    if (spec.cooldownS) {
      const k = `${i.commandName}:${i.user.id}`;
      const until = this.cooldowns.get(k) ?? 0;
      if (until > Date.now()) throw new UserError(`Slow down: you can use this again <t:${Math.ceil(until / 1000)}:R>`);
      this.cooldowns.set(k, Date.now() + spec.cooldownS * 1000);
      if (this.cooldowns.size > 10_000) for (const [ck, v] of this.cooldowns) if (v < Date.now()) this.cooldowns.delete(ck);
    }
  }
}

export async function targetChannel(i: CommandInteraction, spec: Pick<CommandSpec, 'channelOption' | 'useParentChannel'>): Promise<GuildBasedChannel> {
  if (!i.guild) throw new UserError(t('error.serverOnly'));
  const chosen = spec.channelOption && i.isChatInputCommand() ? i.options.getChannel(spec.channelOption) : null;
  let channel = (chosen ? await i.guild.channels.fetch(chosen.id) : i.channel ?? (await i.guild.channels.fetch(i.channelId))) as GuildBasedChannel | null;
  if (!channel) throw new UserError('I can’t see that channel');
  if (spec.useParentChannel && channel.isThread() && channel.parent) channel = channel.parent;
  return channel;
}
