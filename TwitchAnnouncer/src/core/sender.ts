import type { AnnouncementMessage } from './types.ts';

export type SendFailureKind =
  | 'forbidden'
  | 'missing'
  | 'retryable';

export class SendError extends Error {
  readonly kind: SendFailureKind;
  constructor(kind: SendFailureKind, message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = 'SendError';
    this.kind = kind;
  }
}

export interface SendTarget {
  guildId: string;
  channelId: string;
  crosspost: boolean;
}

export interface Sender {
  send(target: SendTarget, message: AnnouncementMessage): Promise<string>;
  notifyBroken(guildId: string, logChannelId: string | null, text: string): Promise<void>;
}
