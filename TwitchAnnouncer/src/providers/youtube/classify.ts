import type { EventKind } from '../../core/types.ts';
import { parseIsoDuration } from './parse.ts';

export interface VideoDetails {
  id: string;
  snippet?: {
    title?: string;
    description?: string;
    channelId?: string;
    channelTitle?: string;
    publishedAt?: string;
    liveBroadcastContent?: 'none' | 'live' | 'upcoming';
  };
  contentDetails?: { duration?: string };
  liveStreamingDetails?: { actualStartTime?: string; actualEndTime?: string; scheduledStartTime?: string };
  player?: { embedWidth?: string | number; embedHeight?: string | number };
}

export const SHORT_MAX_SECONDS = 180;

export function classifyVideo(v: VideoDetails): EventKind {
  const broadcast = v.snippet?.liveBroadcastContent;
  if (broadcast === 'live' || broadcast === 'upcoming') return 'PREMIERE';
  if (v.liveStreamingDetails?.actualEndTime) return 'LIVE_VOD';
  const seconds = parseIsoDuration(v.contentDetails?.duration);
  const w = Number(v.player?.embedWidth ?? 0);
  const h = Number(v.player?.embedHeight ?? 0);
  if (seconds > 0 && seconds <= SHORT_MAX_SECONDS && h > w && w > 0) return 'SHORT';
  return 'UPLOAD';
}
