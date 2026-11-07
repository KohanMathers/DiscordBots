import type { ModalSubmitInteraction } from 'discord.js';
import { UserError } from '../core/errors.ts';
import type { EmbedSpec } from '../services/schedule.ts';

export function readContentModal(i: ModalSubmitInteraction): { text: string; embed: EmbedSpec | null } {
  const get = (id: string) => {
    try {
      return i.fields.getTextInputValue(id).trim();
    } catch {
      return '';
    }
  };
  const title = get('title');
  const colorRaw = get('color');
  const image = get('image');
  let color: number | undefined;
  if (colorRaw) {
    if (!/^#?[0-9a-f]{6}$/i.test(colorRaw)) throw new UserError('The colour must be a hex code like `#5865F2`');
    color = parseInt(colorRaw.replace('#', ''), 16);
  }
  if (image && !/^https:\/\/\S+$/i.test(image)) throw new UserError('The image must be an https:// link');
  const e: EmbedSpec = { ...(title ? { title } : {}), ...(color !== undefined ? { color } : {}), ...(image ? { image } : {}) };
  return { text: get('text'), embed: Object.keys(e).length ? e : null };
}

