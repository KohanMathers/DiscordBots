import { InteractionContextType, SlashCommandBuilder } from 'discord.js';
import { pickTonight, pickTwoFacts } from '../../core/content.ts';
import { UserError } from '../../core/errors.ts';
import { respond } from '../../discord/replies.ts';
import { t } from '../../messages.ts';
import type { CommandSpec, Module } from '../types.ts';

const fill = (template: string, vars: Record<string, string>) => template.replace(/\{(\w+)\}/g, (m, k: string) => vars[k] ?? m);

const fun: CommandSpec = {
  replyMode: 'public',
  cooldownS: 3,
  data: new SlashCommandBuilder()
    .setName('fun')
    .setDescription('Silly generated intros')
    .setContexts(InteractionContextType.Guild)
    .addSubcommand((s) => s.setName('intro').setDescription('Generate an absurd Stig fact.').addUserOption((o) => o.setName('member').setDescription('Who it’s about (default: you)')))
    .addSubcommand((s) => s.setName('tonight').setDescription('Generate a Top Gear intro.'))
    .toJSON(),
  async execute(i, ctx) {
    if (!i.isChatInputCommand()) return;
    const c = ctx.content;
    if (i.options.getSubcommand() === 'tonight') {
      if (c.slots.some((s) => !s.length)) throw new UserError('The tonight content pack is missing');
      const [slot1, slot2, slot3] = pickTonight(c.slots);
      await respond(i, { content: fill(c.templates.tonight ?? t('fun.tonight'), { slot1, slot2, slot3 }) });
      return;
    }
    if (c.facts.length < 2) throw new UserError('The intro content pack is missing');
    const user = i.options.getUser('member') ?? i.user;
    const member = await i.guild!.members.fetch(user.id).catch(() => null);
    const [fact1, fact2] = pickTwoFacts(c.facts);
    await respond(i, { content: fill(c.templates.intro ?? t('fun.intro'), { fact1, fact2, name: member?.displayName ?? user.displayName }) });
  },
};

export const funModule: Module = {
  id: 'fun',
  name: 'Fun',
  description: 'Generated Top Gear-style intros (content comes from content packs)',
  commands: [fun],
};
