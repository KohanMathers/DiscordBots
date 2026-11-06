import { z } from 'zod';

const schema = z.object({
  QTI_ADMIN_IDS: z
    .string()
    .optional()
    .transform((v) => (v ? v.split(',').map((s) => s.trim()).filter(Boolean) : [])),
  QTI_MOTD_URL: z.string().url().default('https://api.quietterminal.co.uk/api/motd'),
  QTI_MOTD_TOKEN: z
    .string()
    .optional()
    .transform((v) => (v && v.trim() ? v.trim() : undefined)),
});

export type QtiConfig = z.infer<typeof schema>;

let cached: QtiConfig | null = null;
export function qtiConfig(env: NodeJS.ProcessEnv = process.env): QtiConfig {
  cached ??= schema.parse(env);
  return cached;
}
