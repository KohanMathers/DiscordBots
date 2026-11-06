import type { EmbedData } from '../quill/render.ts';

const BLUE = 0x5865f2;
const RED = 0xed4245;

export const PLUGIN_NAME = /^[A-Za-z0-9_.-]{1,64}$/;

export function verEmbed(where: string): EmbedData {
  return {
    title: 'Version Check Instructions',
    color: BLUE,
    description: `Please run the following command in your server console or in-game:\n\n\`\`\`\n/ver\n\`\`\`\nThen paste the entire output in ${where}`,
    fields: [{ name: 'What to include:', value: '• Server version information\n• Any version warnings or notices' }],
    footer: 'This helps us provide better support!',
  };
}

export function prndebugEmbed(): EmbedData {
  return {
    title: 'Pronouns Debug Instructions',
    color: BLUE,
    description: 'Follow these steps to debug the Pronouns plugin:',
    fields: [
      { name: 'Step 1: Prepare', value: 'Make sure you have 2 people online with different pronouns set' },
      { name: 'Step 2: Test Player 1', value: "Run the following command (replace `<player>` with the first player's name):\n```\n/papi parse <player> %pronouns%\n```Example: `/papi parse IEatSystemFiles %pronouns%`" },
      { name: 'Step 3: Test Player 2', value: 'Run the same command for the second player with different pronouns' },
      {
        name: 'Step 4: Verify',
        value: 'Check if the outputted pronouns are correct:\n• If each player shows their own pronouns = Working correctly\n• If they display the same pronouns = Plugin bug\n• If they only show the command runner\'s pronouns = Plugin bug',
      },
    ],
    footer: 'Paste the results here for further assistance',
  };
}

export function configEmbed(plugin: string, where: string): EmbedData {
  return {
    title: `Config Instructions - ${plugin}`,
    color: BLUE,
    description: `Please send the \`config.yml\` file from the ${plugin} plugin folder.\n\nYou can find it here:`,
    fields: [
      { name: 'File Location:', value: `\`server/plugins/${plugin}/config.yml\`` },
      { name: 'How to send:', value: `1. Locate the file in your server files\n2. Upload it directly to ${where}\n3. Or paste the contents in a code block:\n\`\`\`\n\`\`\`yaml\n(paste config here)\n\`\`\`\n\`\`\`` },
    ],
    footer: 'Make sure to send the entire file!',
  };
}

export function missingPluginEmbed(): EmbedData {
  return {
    title: 'Error',
    color: RED,
    description: 'Please provide a plugin name!',
    fields: [
      { name: 'Usage:', value: '`/pluginconfig PluginName`' },
      { name: 'Example:', value: '`/pluginconfig Essentials`' },
    ],
  };
}

export function linksEmbed(doc: { title?: string; links: Array<{ label: string; url: string }> }): EmbedData {
  return {
    title: doc.title ?? '🔗 Links',
    color: BLUE,
    description: doc.links.map((l) => `• [${l.label}](${l.url})`).join('\n').slice(0, 4096),
    fields: [],
  };
}
