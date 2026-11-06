import type {
  AnyThreadChannel,
  AuditLogEvent,
  AutocompleteInteraction,
  ChatInputCommandInteraction,
  Guild,
  GuildAuditLogsEntry,
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
import type { CaseTypeDef } from '../core/cases.ts';
import type { Tier } from '../core/permissions.ts';
import type { SettingDef } from '../core/settings.ts';
import type { BotContext } from '../discord/context.ts';
import type { CaseJobHook } from '../services/cases.ts';
import type { Job } from '../services/jobs.ts';

export type CommandInteraction =
  | ChatInputCommandInteraction
  | UserContextMenuCommandInteraction
  | MessageContextMenuCommandInteraction;

export interface CommandSpec {
  data: RESTPostAPIApplicationCommandsJSONBody;
  tier: Tier;
  ownerOnly?: boolean;
  allowInMaintenance?: boolean;
  execute(i: CommandInteraction, ctx: BotContext): Promise<void>;
  autocomplete?(i: AutocompleteInteraction, ctx: BotContext): Promise<void>;
}

export interface ComponentSpec {
  prefix: string;
  tier: Tier;
  handle(i: MessageComponentInteraction | ModalSubmitInteraction, ctx: BotContext, args: string[]): Promise<void>;
}

export type JobHandler = (job: Job, ctx: BotContext) => Promise<void>;

export interface ModuleEvents {
  memberAdd?(member: GuildMember, ctx: BotContext): Promise<void>;
  memberRemove?(member: GuildMember | PartialGuildMember, ctx: BotContext): Promise<void>;
  directMessage?(message: Message, ctx: BotContext): Promise<void>;
  auditLog?(entry: GuildAuditLogsEntry<AuditLogEvent>, guild: Guild, ctx: BotContext): Promise<void>;
  threadDelete?(thread: AnyThreadChannel, ctx: BotContext): Promise<void>;
  ready?(ctx: BotContext): Promise<void>;
}

export interface Module {
  id: string;
  name: string;
  description: string;
  required?: boolean;
  commands?: CommandSpec[];
  components?: ComponentSpec[];
  settings?: SettingDef<any>[];
  caseTypes?: CaseTypeDef[];
  migrations?: Record<string, Migration>;
  jobs?: Record<string, JobHandler>;
  caseHooks?: CaseJobHook[];
  events?: ModuleEvents;
  periodic?: Array<{ name: string; intervalMs: number; initialDelayMs?: number; run(ctx: BotContext): Promise<unknown> }>;
  purgeGuild?(guildId: string, ctx: BotContext): Promise<void>;
  purgeUser?(guildId: string, userId: string, ctx: BotContext): Promise<number>;
}
