import type { Database } from '../../storage/schema.ts';

export interface TicketTable {
  guild_id: string;
  number: number;
  channel_id: string;
  creator_id: string;
  type: string;
  subject: string;
  description: string;
  priority: Priority;
  status: 'open' | 'closed' | 'deleted';
  claimed_by: string | null;
  control_message_id: string | null;
  created_at: string;
  closed_at: string | null;
  closed_by: string | null;
  close_reason: string | null;
}

export interface TicketMemberTable {
  guild_id: string;
  number: number;
  user_id: string;
  added_by: string;
  added_at: string;
}

export interface TicketDatabase extends Database {
  ticket: TicketTable;
  ticket_member: TicketMemberTable;
}

export const PRIORITIES = ['low', 'medium', 'high', 'urgent'] as const;
export type Priority = (typeof PRIORITIES)[number];
export const PRIORITY_LABEL: Record<Priority, string> = { low: '🟢 Low', medium: '🟡 Medium', high: '🟠 High', urgent: '🔴 Urgent' };
