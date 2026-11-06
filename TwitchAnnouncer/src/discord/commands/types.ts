import type {
  AutocompleteInteraction,
  ChatInputCommandInteraction,
  RESTPostAPIChatInputApplicationCommandsJSONBody,
} from 'discord.js';
import type { BotContext } from '../context.ts';

export interface Command {
  data: RESTPostAPIChatInputApplicationCommandsJSONBody;
  help: string;
  execute(i: ChatInputCommandInteraction, ctx: BotContext): Promise<void>;
  autocomplete?(i: AutocompleteInteraction, ctx: BotContext): Promise<void>;
}
