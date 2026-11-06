import { z } from 'zod';

export function parseDuration(value: string): number {
  const m = value.trim().match(/^(\d+(?:\.\d+)?)\s*(ms|s|m|h|d)?$/i);
  if (!m) throw new Error(`invalid duration "${value}"`);
  const n = Number(m[1]);
  const unit = (m[2] ?? 'ms').toLowerCase();
  const factor = { ms: 1, s: 1000, m: 60_000, h: 3_600_000, d: 86_400_000 }[unit] ?? 1;
  return Math.round(n * factor);
}

const duration = (fallback: string, min: number) =>
  z
    .string()
    .default(fallback)
    .transform((v, ctx) => {
      try {
        return parseDuration(v);
      } catch (e) {
        ctx.addIssue({ code: 'custom', message: (e as Error).message });
        return z.NEVER;
      }
    })
    .refine((ms) => ms >= min, { message: `must be at least ${min / 1000}s` });

const optional = z
  .string()
  .optional()
  .transform((v) => (v && v.trim() !== '' ? v.trim() : undefined));

const schema = z.object({
  DISCORD_TOKEN: z.string().min(1, 'DISCORD_TOKEN is required'),
  OWNER_IDS: optional.transform((v) => (v ? v.split(',').map((s) => s.trim()).filter(Boolean) : [])),
  DATABASE_URL: z.string().default('sqlite:data/announcer.db'),

  TWITCH_CLIENT_ID: optional,
  TWITCH_CLIENT_SECRET: optional,
  TWITCH_POLL_INTERVAL: duration('60s', 15_000),

  YOUTUBE_API_KEY: optional,
  YOUTUBE_POLL_INTERVAL: duration('5m', 60_000),

  CATCHUP_MAX_AGE: duration('24h', 60_000),

  HTTP_PORT: z.coerce.number().int().min(0).max(65535).default(8080),
  LOG_LEVEL: z.enum(['trace', 'debug', 'info', 'warn', 'error', 'fatal']).default('info'),
  LOG_FORMAT: z.enum(['text', 'json']).default('text'),

  INFO_AUTHOR_URL: optional,
  INFO_SUPPORT_URL: optional,
  INFO_SOURCE_URL: optional,
});

export type Config = z.infer<typeof schema>;

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const parsed = schema.safeParse(env);
  if (!parsed.success) {
    const lines = parsed.error.issues.map((i) => `  ${i.path.join('.')}: ${i.message}`);
    throw new Error(`Invalid configuration:\n${lines.join('\n')}`);
  }
  return parsed.data;
}
