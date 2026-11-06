import {
  ApplicationCommandType,
  ContextMenuCommandBuilder,
  EmbedBuilder,
  InteractionContextType,
  LabelBuilder,
  ModalBuilder,
  SlashCommandBuilder,
  TextInputBuilder,
  TextInputStyle,
} from 'discord.js';
import { UserError } from '../../core/errors.ts';
import type { CommandSpec, ComponentSpec, Module } from '../../modules/types.ts';
import { DOC_SHORTCUTS, DOCS_BASE, docsEmbed, fetchDocPage, findDocPath, usageEmbed } from './docs.ts';
import { type EmbedData, helpEmbed, resultEmbed } from './render.ts';
import { extractCode } from './run.ts';
import { runInSandbox } from './sandbox.ts';

export function toEmbed(d: EmbedData): EmbedBuilder {
  const e = new EmbedBuilder().setTitle(d.title).setColor(d.color);
  if (d.description) e.setDescription(d.description);
  if (d.fields.length) e.addFields(d.fields);
  if (d.footer) e.setFooter({ text: d.footer });
  if (d.url) e.setURL(d.url);
  return e;
}

const quill: CommandSpec = {
  replyMode: 'public',
  cooldownS: 5,
  data: new SlashCommandBuilder().setName('quill').setDescription('Run Quill code in the sandboxed simulator (a form opens)').setContexts(InteractionContextType.Guild).toJSON(),
  async execute(i) {
    await i.showModal(
      new ModalBuilder()
        .setCustomId('quill:run')
        .setTitle('Run Quill')
        .addLabelComponents(
          new LabelBuilder()
            .setLabel('Setup (optional)')
            .setDescription('PLAYER <name> AT <x> <y> <z> and EVENT <name> [player] lines')
            .setTextInputComponent(new TextInputBuilder().setCustomId('setup').setStyle(TextInputStyle.Paragraph).setRequired(false).setMaxLength(1000).setPlaceholder('PLAYER Steve AT 0 64 0')),
          new LabelBuilder()
            .setLabel('Code')
            .setTextInputComponent(new TextInputBuilder().setCustomId('code').setStyle(TextInputStyle.Paragraph).setRequired(true).setMaxLength(4000).setPlaceholder('let x = 5\nlog(x * 2)')),
        ),
    );
  },
};

const runFromMessage: CommandSpec = {
  replyMode: 'public',
  cooldownS: 5,
  data: new ContextMenuCommandBuilder().setName('Run Quill').setType(ApplicationCommandType.Message).setContexts(InteractionContextType.Guild).toJSON(),
  async execute(i) {
    if (!i.isMessageContextMenuCommand()) return;
    const { code, rest } = extractCode(i.targetMessage.content);
    if (!code) {
      throw new UserError('That message has no code block. Put the code between ```quill and ``` (PLAYER lines can go outside the block)');
    }
    await i.deferReply();
    const result = await runInSandbox(code, rest);
    await i.editReply({ content: `Ran ${i.targetMessage.url}`, embeds: [toEmbed(resultEmbed(result))], allowedMentions: { parse: [] } });
  },
};

const runModal: ComponentSpec = {
  prefix: 'quill',
  async handle(i) {
    if (!i.isModalSubmit()) return;
    await i.deferReply();
    const code = i.fields.getTextInputValue('code');
    const setup = i.fields.getTextInputValue('setup') ?? '';
    const result = await runInSandbox(code, setup);
    const preview = code.length > 900 ? `${code.slice(0, 900)}\n…` : code;
    await i.editReply({ content: `\`\`\`js\n${preview.replace(/```/g, '`​``')}\n\`\`\``, embeds: [toEmbed(resultEmbed(result))], allowedMentions: { parse: [] } });
  },
};

const quillhelp: CommandSpec = {
  replyMode: 'public',
  data: new SlashCommandBuilder().setName('quillhelp').setDescription('Quill simulator syntax and every built-in function').setContexts(InteractionContextType.Guild).toJSON(),
  async execute(i) {
    await i.reply({ embeds: [toEmbed(helpEmbed())] });
  },
};

const quilldocs: CommandSpec = {
  replyMode: 'public',
  cooldownS: 3,
  data: new SlashCommandBuilder()
    .setName('quilldocs')
    .setDescription('Look something up in the Quill documentation')
    .setContexts(InteractionContextType.Guild)
    .addStringOption((o) => o.setName('topic').setDescription('e.g. syntax, player-events, subscopes (leave empty for the list)').setAutocomplete(true).setMaxLength(100))
    .toJSON(),
  async autocomplete(i) {
    const typed = i.options.getFocused().toLowerCase().replace(/\s+/g, '-');
    const keys = Object.keys(DOC_SHORTCUTS).filter((k) => k.includes(typed)).sort();
    await i.respond(keys.slice(0, 25).map((k) => ({ name: k, value: k })));
  },
  async execute(i) {
    if (!i.isChatInputCommand()) return;
    const topic = i.options.getString('topic');
    if (!topic) {
      await i.reply({ embeds: [toEmbed(usageEmbed())] });
      return;
    }
    const path = findDocPath(topic);
    if (!path) {
      throw new UserError(`I couldn’t find documentation for **${topic}**. Run \`/quilldocs\` with no topic for the list, or see ${DOCS_BASE}`);
    }
    await i.deferReply();
    let page: Awaited<ReturnType<typeof fetchDocPage>>;
    try {
      page = await fetchDocPage(path);
    } catch {
      throw new UserError(`The docs site didn’t answer. Try again later or open ${DOCS_BASE}${path}`);
    }
    if (page === 'missing') throw new UserError(`There’s no docs page at ${DOCS_BASE}${path}`);
    if (page === 'unparseable') throw new UserError(`That page doesn’t look like a docs page, so I can’t summarise it: ${DOCS_BASE}${path}`);
    await i.editReply({ embeds: [toEmbed(docsEmbed(page, DOCS_BASE + path))] });
  },
};

export const quillModule: Module = {
  id: 'quill',
  name: 'Quill',
  description: 'Run Quill scripts in a sandboxed simulator and look up the Quill docs',
  commands: [quill, runFromMessage, quillhelp, quilldocs],
  components: [runModal],
};
