export type ProviderId = string;

export const EVENT_KINDS = ['LIVE_START', 'LIVE_END', 'UPLOAD', 'SHORT', 'PREMIERE', 'LIVE_VOD'] as const;
export type EventKind = (typeof EVENT_KINDS)[number];

export interface SourceRef {
  provider: ProviderId;
  externalId: string;
  displayName: string;
  handle: string;
  avatarUrl: string | null;
  url: string;
}

export interface SourceEvent {
  provider: ProviderId;
  externalId: string;
  kind: EventKind;
  itemId: string;
  title: string;
  subtitle: string | null;
  url: string;
  imageUrl: string | null;
  occurredAt: string;
  extra: Record<string, unknown>;
}

export interface EmbedSpec {
  title: string;
  description: string;
  url?: string;
  color: number;
  imageUrl?: string;
  thumbnailUrl?: string;
  footer?: string;
  timestamp?: string;
}

export interface AnnouncementMessage {
  content?: string;
  allowedRoleIds: string[];
  embed: EmbedSpec;
}

export type ResolveResult =
  | { ok: true; source: SourceRef }
  | { ok: false; reason: 'invalid_input' | 'not_found'; message: string };

export interface PollResult {
  events: SourceEvent[];
  updatedRefs: SourceRef[];
  errors: Array<{ externalId: string; error: string }>;
}

export type FirstSyncMode = 'announce-current' | 'mark-seen';

export interface PollContext {
  isKnown(externalId: string, itemId: string): boolean;
  isFirstPoll(externalId: string): boolean;
  maxAgeMs: number;
  now: Date;
}

export interface Provider {
  readonly id: ProviderId;
  readonly displayName: string;
  readonly enabled: boolean;
  readonly firstSync: FirstSyncMode;
  readonly filterableKinds: readonly EventKind[];
  readonly pollIntervalMs: number;

  resolve(input: string): Promise<ResolveResult>;
  poll(sources: SourceRef[], ctx: PollContext): Promise<PollResult>;
  refresh(sources: SourceRef[]): Promise<SourceRef[]>;
  render(event: SourceEvent, source: SourceRef): AnnouncementMessage;
  sampleEvent(source: SourceRef): SourceEvent;
  status(): Record<string, string>;
}
