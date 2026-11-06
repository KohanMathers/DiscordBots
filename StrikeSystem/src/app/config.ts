import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { z } from 'zod';
import { parseDuration } from '../core/duration.ts';

const duration = (fallback: string) =>
  z
    .string()
    .default(fallback)
    .transform((v, ctx) => {
      try {
        return parseDuration(v, { max: 3650 * 86400 }) * 1000;
      } catch (e) {
        ctx.addIssue({ code: 'custom', message: (e as Error).message });
        return z.NEVER;
      }
    });

const optional = z
  .string()
  .optional()
  .transform((v) => (v && v.trim() !== '' ? v.trim() : undefined));

const schema = z.object({
  DISCORD_TOKEN: z.string({ error: 'DISCORD_TOKEN (or DISCORD_TOKEN_FILE) is required' }).min(1, 'DISCORD_TOKEN (or DISCORD_TOKEN_FILE) is required'),
  OWNER_IDS: optional.transform((v) => (v ? v.split(',').map((s) => s.trim()).filter(Boolean) : [])),
  DEV_GUILD_ID: optional,
  DATA_DIR: z.string().default('data'),
  HTTP_PORT: z.coerce.number().int().min(0).max(65535).default(8080),
  LOG_LEVEL: z.enum(['trace', 'debug', 'info', 'warn', 'error', 'fatal']).default('info'),
  LOG_FORMAT: z.enum(['text', 'json']).default('text'),
  BACKUP_INTERVAL: duration('24h'),
  BACKUP_KEEP: z.coerce.number().int().min(1).max(365).default(7),
  GUILD_DATA_GRACE: duration('30d'),
  EVIDENCE_MAX_MB: z.coerce.number().min(1).max(25).default(8),
});

export type Config = z.infer<typeof schema> & { dbPath: string; evidenceDir: string; backupDir: string };

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const merged = { ...env };
  if (!merged.DISCORD_TOKEN && merged.DISCORD_TOKEN_FILE) {
    merged.DISCORD_TOKEN = readFileSync(merged.DISCORD_TOKEN_FILE, 'utf8').trim();
  }
  const parsed = schema.safeParse(merged);
  if (!parsed.success) {
    const lines = parsed.error.issues.map((i) => `  ${i.path.join('.')}: ${i.message}`);
    throw new Error(`Invalid configuration:\n${lines.join('\n')}`);
  }
  const c = parsed.data;
  return {
    ...c,
    dbPath: join(c.DATA_DIR, 'strikes.db'),
    evidenceDir: join(c.DATA_DIR, 'evidence'),
    backupDir: join(c.DATA_DIR, 'backups'),
  };
}
