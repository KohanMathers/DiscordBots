export interface GuildTable {
  guild_id: string;
  joined_at: string;
  left_at: string | null;
}

export interface GuildSettingsTable {
  guild_id: string;
  data: string;
  updated_at: string;
}

export interface CaseTable {
  id: string;
  guild_id: string;
  number: number;
  type: string;
  target_id: string | null;
  actor_id: string;
  reason: string | null;
  created_at: string;
  expires_at: string | null;
  duration_s: number | null;
  status: string;
  revoked_by: string | null;
  revoked_at: string | null;
  revoke_reason: string | null;
  parent_case: string | null;
  evidence: string;
  dm_status: string;
  log_message_id: string | null;
  metadata: string;
  legacy_ref: string | null;
}

export interface EscalationMarkerTable {
  guild_id: string;
  user_id: string;
  at: number;
  case_id: string;
  fired_at: string;
}

export interface JobTable {
  id: string;
  guild_id: string | null;
  type: string;
  payload: string;
  run_at: string;
  status: 'pending' | 'running' | 'done' | 'failed';
  attempts: number;
  max_attempts: number;
  last_error: string | null;
  dedupe_key: string | null;
  created_at: string;
  finished_at: string | null;
}

export interface TrackerTable {
  guild_id: string;
  channel_id: string;
  message_ids: string;
}

export interface WatchlistTable {
  guild_id: string;
  user_id: string;
  action: 'ban' | 'alert' | 'timeout';
  duration_s: number | null;
  reason: string | null;
  actor_id: string;
  created_at: string;
  legacy_ref: string | null;
}

export interface ModmailThreadTable {
  id: string;
  guild_id: string;
  user_id: string;
  thread_id: string;
  status: 'open' | 'closed';
  created_at: string;
  closed_at: string | null;
  closed_by: string | null;
  close_reason: string | null;
}

export interface ModmailMessageTable {
  id: string;
  conversation_id: string;
  direction: 'in' | 'out';
  author_id: string;
  anonymous: number;
  content: string;
  attachments: string;
  created_at: string;
}

export interface ModmailBlockTable {
  guild_id: string;
  user_id: string;
  actor_id: string;
  created_at: string;
}

export interface MetaTable {
  key: string;
  value: string;
}

export interface Database {
  guild: GuildTable;
  guild_settings: GuildSettingsTable;
  cases: CaseTable;
  escalation_marker: EscalationMarkerTable;
  jobs: JobTable;
  tracker: TrackerTable;
  watchlist: WatchlistTable;
  modmail_thread: ModmailThreadTable;
  modmail_message: ModmailMessageTable;
  modmail_block: ModmailBlockTable;
  meta: MetaTable;
}
