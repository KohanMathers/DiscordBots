import type {
  AutocompleteInteraction,
  ChatInputCommandInteraction,
  Guild,
  GuildMember,
  Message,
  MessageComponentInteraction,
  MessageContextMenuCommandInteraction,
  ModalSubmitInteraction,
  PartialGuildMember,
  RESTPostAPIApplicationCommandsJSONBody,
  UserContextMenuCommandInteraction,
} from 'discord.js';
import type { Migration } from 'kysely/migration';
import type { SettingSpec } from '../core/settings.ts';
import type { BotContext } from '../discord/context.ts';
import type { Job } from '../services/jobs.ts';

export type CommandInteraction = ChatInputCommandInteraction | UserContextMenuCommandInteraction | MessageContextMenuCommandInteraction;

export interface CommandSpec {
  data: RESTPostAPIApplicationCommandsJSONBody;
  memberPermissions?: bigint[];
  permAction?: string;
  botPermissions?: bigint[];
  channelOption?: string;
  useParentChannel?: boolean;
  replyMode: 'ephemeral' | 'public';
  slow?: boolean;
  cooldownS?: number;
  execute(i: CommandInteraction, ctx: BotContext): Promise<void>;
  autocomplete?(i: AutocompleteInteraction, ctx: BotContext): Promise<void>;
}

export interface ComponentSpec {
  prefix: string;
  memberPermissions?: bigint[];
  handle(i: MessageComponentInteraction | ModalSubmitInteraction, ctx: BotContext, args: string[]): Promise<void>;
}

export type JobHandler = (job: Job, ctx: BotContext) => Promise<void>;

export interface ModuleEvents {
  memberAdd?(m: GuildMember, ctx: BotContext): Promise<void>;
  memberRemove?(m: GuildMember | PartialGuildMember, ctx: BotContext): Promise<void>;
  message?(m: Message<true>, ctx: BotContext): Promise<void>;
  guildJoin?(g: Guild, ctx: BotContext): Promise<void>;
  ready?(ctx: BotContext): Promise<void>;
}

export interface Module {
  id: string;
  name: string;
  description: string;
  required?: boolean;
  needsMessageContent?: boolean;
  commands?: CommandSpec[];
  components?: ComponentSpec[];
  settings?: SettingSpec<any>[];
  migrations?: Record<string, Migration>;
  jobs?: Record<string, JobHandler>;
  events?: ModuleEvents;
  exportData?(guildId: string, ctx: BotContext): Promise<Record<string, unknown>>;
  periodic?: Array<{ name: string; intervalMs: number; initialDelayMs?: number; run(ctx: BotContext): Promise<unknown> }>;
}
