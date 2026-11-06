import { describe, expect, it } from 'vitest';
import { parseDuration } from '../src/app/config.ts';
import { nextRetryDelayMs } from '../src/core/backoff.ts';
import { livePreviewUrl, parseTwitchInput } from '../src/providers/twitch/parse.ts';
import { excerpt, parseIsoDuration, parseYouTubeInput } from '../src/providers/youtube/parse.ts';

describe('parseTwitchInput', () => {
  it.each([
    ['Shroud', 'shroud'],
    ['  @Pokimane ', 'pokimane'],
    ['https://www.twitch.tv/xQc', 'xqc'],
    ['twitch.tv/some_user/videos?filter=all', 'some_user'],
    ['m.twitch.tv/abc123', 'abc123'],
  ])('%s -> %s', (input, expected) => expect(parseTwitchInput(input)).toBe(expected));

  it.each(['', 'has space', 'https://youtube.com/@x', 'a'.repeat(26), 'bad-char'])('rejects %s', (input) =>
    expect(parseTwitchInput(input)).toBeNull(),
  );

  it('cache-busts the live preview with the stream start time', () => {
    expect(livePreviewUrl('shroud', '2026-11-05T12:00:00Z')).toBe(
      'https://static-cdn.jtvnw.net/previews-ttv/live_user_shroud-1920x1080.jpg?t=1793880000',
    );
  });
});

describe('parseYouTubeInput', () => {
  it.each([
    ['@MrBeast', { type: 'handle', value: '@mrbeast' }],
    ['mrbeast', { type: 'handle', value: '@mrbeast' }],
    ['https://www.youtube.com/@Some.Name-1/videos', { type: 'handle', value: '@some.name-1' }],
    ['youtube.com/channel/UCX6OQ3DkcsbYNE6H8uQQuVA', { type: 'channelId', value: 'UCX6OQ3DkcsbYNE6H8uQQuVA' }],
    ['UCX6OQ3DkcsbYNE6H8uQQuVA', { type: 'channelId', value: 'UCX6OQ3DkcsbYNE6H8uQQuVA' }],
    ['https://youtube.com/user/LegacyName', { type: 'username', value: 'LegacyName' }],
  ])('%s', (input, expected) => expect(parseYouTubeInput(input)).toEqual(expected));

  it.each(['', 'ab', 'https://www.youtube.com/watch?v=abc', 'has space'])('rejects %s', (input) =>
    expect(parseYouTubeInput(input)).toBeNull(),
  );
});

describe('helpers', () => {
  it('parses ISO durations', () => {
    expect(parseIsoDuration('PT1M5S')).toBe(65);
    expect(parseIsoDuration('PT2H')).toBe(7200);
    expect(parseIsoDuration('P1DT1S')).toBe(86401);
    expect(parseIsoDuration('P0D')).toBe(0);
    expect(parseIsoDuration(undefined)).toBe(0);
  });

  it('cuts descriptions at 200 characters with "..."', () => {
    expect(excerpt('short')).toBe('short');
    expect(excerpt('x'.repeat(250))).toBe(`${'x'.repeat(200)}...`);
  });

  it('parses config durations', () => {
    expect(parseDuration('60s')).toBe(60_000);
    expect(parseDuration('5m')).toBe(300_000);
    expect(parseDuration('24h')).toBe(86_400_000);
    expect(() => parseDuration('soon')).toThrow();
  });

  it('retries 3 attempts over about 5 minutes', () => {
    expect(nextRetryDelayMs(1)).toBe(60_000);
    expect(nextRetryDelayMs(2)).toBe(240_000);
    expect(nextRetryDelayMs(3)).toBeNull();
  });
});
