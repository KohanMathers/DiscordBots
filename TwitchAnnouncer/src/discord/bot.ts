import { createHash } from 'node:crypto';
import { ActivityType, Client, Events, GatewayIntentBits, type Interaction, Team } from 'discord.js';
import type { Logger } from 'pino';
import type { ProviderInfo } from '../providers/registry.ts';
import type { Store } from '../storage/store.ts';
import { announcerCommand } from './commands/announcer.ts';
import { creatorCommand } from './commands/creators.ts';
import { helpCommand, infoCommand, pingCommand, statusCommand } from './commands/general.ts';
import type { Command } from './commands/types.ts';
import type { BotContext } from './context.ts';
import { handleCommandError, safeAutocomplete } from './replies.ts';

export function createClient(): Client {
  return new Client({
    intents: [GatewayIntentBits.Guilds],
    presence: { activities: [{ name: 'for streams', type: ActivityType.Watching }] },
  });
}

export function buildCommands(catalog: ProviderInfo[]): Command[] {
  const commands: Command[] = [
    ...catalog.map(creatorCommand),
    announcerCommand(catalog),
    pingCommand,
    infoCommand,
    statusCommand,
  ];
  commands.push(helpCommand(() => commands));
  return commands;
}

export async function syncCommands(client: Client<true>, commands: Command[], store: Store, log: Logger) {
  const body = commands.map((c) => c.data);
  const hash = createHash('sha256')
    .update(client.application.id)
    .update(JSON.stringify(body))
    .digest('hex');
  if ((await store.getMeta('commands_hash')) === hash) {
    log.debug('commands unchanged, skipping sync');
    return;
  }
  await client.application.commands.set(body);
  await store.setMeta('commands_hash', hash);
  log.info({ count: body.length }, 'global commands synced');
}

export async function resolveOwners(client: Client<true>, configured: string[]): Promise<Set<string>> {
  if (configured.length) return new Set(configured);
  const app = await client.application.fetch();
  if (app.owner instanceof Team) return new Set(app.owner.members.map((m) => m.id));
  return new Set(app.owner ? [app.owner.id] : []);
}

export function attachHandlers(ctx: BotContext, commands: Command[]): void {
  const byName = new Map(commands.map((c) => [c.data.name, c]));
  const { client, store, log } = ctx;

  client.on(Events.InteractionCreate, async (i: Interaction) => {
    if (i.isAutocomplete()) {
      const cmd = byName.get(i.commandName);
      if (cmd?.autocomplete) await safeAutocomplete(i, log, () => cmd.autocomplete!(i, ctx));
      return;
    }
    if (!i.isChatInputCommand()) return;
    const cmd = byName.get(i.commandName);
    if (!cmd) return;
    if (!i.inGuild()) {
      await i.reply({ content: 'Use this in a server.' }).catch(() => undefined);
      return;
    }
    try {
      await cmd.execute(i, ctx);
    } catch (err) {
      await handleCommandError(i, err, log);
    }
  });

  client.on(Events.GuildCreate, (guild) => {
    store.ensureGuild(guild.id).catch((err) => log.error({ err, guildId: guild.id }, 'guild join bookkeeping failed'));
    log.info({ guildId: guild.id }, 'joined guild');
  });

  client.on(Events.GuildDelete, (guild) => {
    if (!guild.available) return;
    store.markGuildLeft(guild.id).catch((err) => log.error({ err, guildId: guild.id }, 'guild leave bookkeeping failed'));
    log.info({ guildId: guild.id }, 'left guild');
  });
}
