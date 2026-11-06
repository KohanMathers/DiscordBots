import { readFileSync } from 'node:fs';
import { z } from 'zod';

const optional = z
  .string()
  .optional()
  .transform((v) => (v && v.trim() !== '' ? v.trim() : undefined));

const bool = (fallback: boolean) =>
  z
    .string()
    .optional()
    .transform((v) => (v === undefined || v.trim() === '' ? fallback : ['1', 'true', 'yes', 'on'].includes(v.trim().toLowerCase())));

const schema = z.object({
  DISCORD_TOKEN: z.string({ error: 'DISCORD_TOKEN (or DISCORD_TOKEN_FILE) is required' }).min(1, 'DISCORD_TOKEN (or DISCORD_TOKEN_FILE) is required'),
  DATABASE_URL: z.string().default('sqlite:///data/mm.db'),
  DEV_GUILD_IDS: optional.transform((v) => (v ? v.split(',').map((s) => s.trim()).filter(Boolean) : [])),
  LOG_LEVEL: z.enum(['trace', 'debug', 'info', 'warn', 'error', 'fatal']).default('info'),
  LOG_FORMAT: z.enum(['text', 'json']).default('text'),
  SUPPORT_URL: optional,
  MODULES: optional.transform((v) => (v ? v.split(',').map((s) => s.trim()).filter(Boolean) : null)),
  ENABLE_MESSAGE_CONTENT: bool(false),
  METRICS_PORT: optional.transform((v) => (v ? Number(v) : undefined)),
  HTTP_PORT: optional.transform((v) => (v ? Number(v) : undefined)),
  GUILD_DATA_GRACE_DAYS: z.coerce.number().int().min(0).max(365).default(30),
});

export type Config = z.infer<typeof schema> & { dbPath: string; port: number | undefined };

export function parseDatabaseUrl(url: string): string {
  if (url === 'sqlite::memory:' || url === ':memory:') return ':memory:';
  const m = url.match(/^sqlite:(?:\/\/)?(\/?)(.*)$/);
  if (!m) throw new Error('DATABASE_URL must be a sqlite: URL (Postgres is not supported yet)');
  return m[2]!;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const merged = { ...env };
  if (!merged.DISCORD_TOKEN && merged.DISCORD_TOKEN_FILE) merged.DISCORD_TOKEN = readFileSync(merged.DISCORD_TOKEN_FILE, 'utf8').trim();
  const parsed = schema.safeParse(merged);
  if (!parsed.success) {
    throw new Error(`Invalid configuration:\n${parsed.error.issues.map((i) => `  ${i.path.join('.')}: ${i.message}`).join('\n')}`);
  }
  const c = parsed.data;
  return { ...c, dbPath: parseDatabaseUrl(c.DATABASE_URL), port: c.METRICS_PORT ?? c.HTTP_PORT };
}
