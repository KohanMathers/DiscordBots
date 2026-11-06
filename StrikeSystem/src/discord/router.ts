import { ApplicationCommandType, type Interaction, MessageFlags } from 'discord.js';
import { UserError } from '../core/errors.ts';
import { tierAllows } from '../core/permissions.ts';
import type { CommandSpec, ComponentSpec, Module } from '../modules/types.ts';
import type { BotContext } from './context.ts';
import { interactionTier } from './members.ts';
import { handleInteractionError } from './replies.ts';

interface Routed<T> {
  spec: T;
  module: Module;
}

const commandKey = (type: number, name: string) => `${type}:${name}`;

export class Router {
  private readonly commands = new Map<string, Routed<CommandSpec>>();
  private readonly components = new Map<string, Routed<ComponentSpec>>();

  constructor(modules: Module[]) {
    for (const module of modules) {
      for (const spec of module.commands ?? []) {
        const key = commandKey(spec.data.type ?? ApplicationCommandType.ChatInput, spec.data.name);
        if (this.commands.has(key)) throw new Error(`command ${key} registered twice`);
        this.commands.set(key, { spec, module });
      }
      for (const spec of module.components ?? []) {
        if (this.components.has(spec.prefix)) throw new Error(`component prefix ${spec.prefix} registered twice`);
        this.components.set(spec.prefix, { spec, module });
      }
    }
  }

  allCommands(): Array<Routed<CommandSpec>> {
    return [...this.commands.values()];
  }

  async handle(i: Interaction, ctx: BotContext): Promise<void> {
    try {
      if (i.isAutocomplete()) {
        const r = this.commands.get(commandKey(ApplicationCommandType.ChatInput, i.commandName));
        if (r?.spec.autocomplete && i.inGuild()) await r.spec.autocomplete(i, ctx).catch(() => i.respond([]));
        return;
      }
      if (i.isCommand()) {
        const r = this.commands.get(commandKey(i.commandType, i.commandName));
        if (!r) return;
        await this.gate(i, ctx, r.module, r.spec.tier, r.spec);
        const started = Date.now();
        try {
          await r.spec.execute(i as never, ctx);
          ctx.metrics.inc('strikes_commands_total', { command: i.commandName, outcome: 'ok' });
        } catch (err) {
          ctx.metrics.inc('strikes_commands_total', { command: i.commandName, outcome: err instanceof UserError ? 'refused' : 'error' });
          throw err;
        } finally {
          ctx.log.debug({ command: i.commandName, ms: Date.now() - started }, 'command handled');
        }
        return;
      }
      if (i.isMessageComponent() || i.isModalSubmit()) {
        const [prefix = '', ...args] = i.customId.split(':');
        const r = this.components.get(prefix);
        if (!r) return;
        await this.gate(i, ctx, r.module, r.spec.tier);
        await r.spec.handle(i, ctx, args);
      }
    } catch (err) {
      await handleInteractionError(i, err, ctx.log);
    }
  }

  private async gate(i: Interaction, ctx: BotContext, module: Module, tier: CommandSpec['tier'], spec?: CommandSpec) {
    if (spec?.ownerOnly) {
      if (!ctx.owners.has(i.user.id)) throw new UserError('Only the bot owner can use this.');
      return;
    }
    if (!i.inGuild()) {
      if (tier === 'public') return;
      throw new UserError('Use this in a server.');
    }
    if (!(await ctx.isModuleEnabled(i.guildId, module.id))) {
      throw new UserError(`The **${module.name}** module is turned off in this server. An admin can enable it with \`/modules enable\`.`);
    }
    if (ctx.maintenance.on && tier !== 'public' && !spec?.allowInMaintenance) throw new UserError(ctx.maintenance.message);
    const settings = await ctx.settings.get(i.guildId);
    if (!tierAllows(interactionTier(i, settings), tier)) {
      throw new UserError(tier === 'admin' ? 'You need admin access to do that.' : 'You need moderator access to do that.');
    }
  }
}

export const EPHEMERAL = MessageFlags.Ephemeral;
