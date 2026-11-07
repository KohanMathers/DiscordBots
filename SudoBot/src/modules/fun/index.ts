import { InteractionContextType, SlashCommandBuilder } from 'discord.js';
import { pickMemberTonight, pickTonight, pickTwoFacts } from '../../core/content.ts';
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
    .addSubcommand((s) =>
      s
        .setName('membertonight')
        .setDescription('Generate a Top Gear intro starring three members.')
        .addUserOption((o) => o.setName('member1').setDescription('First member').setRequired(true))
        .addUserOption((o) => o.setName('member2').setDescription('Second member').setRequired(true))
        .addUserOption((o) => o.setName('member3').setDescription('Third member').setRequired(true)),
    )
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
    if (i.options.getSubcommand() === 'membertonight') {
      if (!c.memberTonight.length) throw new UserError('The tonight content pack is missing');
      const users = [i.options.getUser('member1', true), i.options.getUser('member2', true), i.options.getUser('member3', true)];
      const names = await Promise.all(
        users.map(async (u) => (await i.guild!.members.fetch(u.id).catch(() => null))?.displayName ?? u.displayName),
      );
      const entries = pickMemberTonight(c.memberTonight);
      const slots = entries.map((entry, idx) => entry.replace(/\{1\}/g, names[idx]!).replace(/\{2\}/g, names[(idx + 1) % 3]!));
      await respond(i, {
        content: fill(c.templates.membertonight ?? t('fun.membertonight'), { slot1: slots[0]!, slot2: slots[1]!, slot3: slots[2]! }),
      });
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
