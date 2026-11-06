export interface GuildTable {
  guild_id: string;
  created_at: string;
  left_at: string | null;
}

export interface GuildSettingTable {
  guild_id: string;
  key: string;
  value_json: string;
}

export interface AuditLogTable {
  id: string;
  guild_id: string;
  actor_id: string;
  action: string;
  target: string | null;
  payload_json: string;
  at: string;
}

export interface MemberJoinTable {
  guild_id: string;
  user_id: string;
  joined_at: string;
  is_bot: number;
}

export interface ChannelLockTable {
  guild_id: string;
  channel_id: string;
  locked_at: string;
  locked_by: string;
  reason: string | null;
  expires_at: string | null;
}

export interface ChannelLockOverrideTable {
  guild_id: string;
  channel_id: string;
  target_id: string;
  target_type: 'role' | 'member';
  existed: number;
  prior_send: string;
  prior_send_in_threads: string;
}

export interface AutoResponseTable {
  guild_id: string;
  keyword_norm: string;
  keyword: string;
  response: string;
  embed_json: string | null;
  match_mode: string;
  allowed_mentions: string;
  created_by: string;
  created_at: string;
  use_count: number;
}

export interface ScheduledMessageTable {
  id: string;
  guild_id: string;
  keyword: string;
  channel_id: string;
  content: string;
  embed_json: string | null;
  run_at: string;
  local_time: string;
  anchor_day: number;
  recurrence: string | null;
  timezone: string;
  allowed_mentions: string;
  status: 'pending' | 'sent' | 'failed' | 'cancelled';
  attempts: number;
  last_error: string | null;
  lease_until: string | null;
  created_by: string;
  created_at: string;
  sent_at: string | null;
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

export interface MetaTable {
  key: string;
  value: string;
}

export interface Database {
  guild: GuildTable;
  guild_setting: GuildSettingTable;
  audit_log: AuditLogTable;
  member_join: MemberJoinTable;
  channel_lock: ChannelLockTable;
  channel_lock_override: ChannelLockOverrideTable;
  auto_response: AutoResponseTable;
  scheduled_message: ScheduledMessageTable;
  jobs: JobTable;
  meta: MetaTable;
}

export const GUILD_TABLES = ['guild_setting', 'audit_log', 'member_join', 'channel_lock', 'channel_lock_override', 'auto_response', 'scheduled_message', 'jobs'] as const;
