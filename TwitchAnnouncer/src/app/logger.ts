import pino, { type Logger } from 'pino';

export function createLogger(level: string, format: 'text' | 'json'): Logger {
  return pino({
    level,
    redact: {
      paths: ['*.token', '*.DISCORD_TOKEN', '*.TWITCH_CLIENT_SECRET', '*.YOUTUBE_API_KEY', '*.authorization'],
      censor: '[redacted]',
    },
    ...(format === 'text'
      ? { transport: { target: 'pino-pretty', options: { translateTime: 'SYS:standard', ignore: 'pid,hostname' } } }
      : {}),
  });
}
