export type SubscriptionState = 'active' | 'paused' | 'broken';
export type DeliveryStatus = 'pending' | 'sent' | 'failed';

export interface GuildTable {
  guild_id: string;
  log_channel_id: string | null;
  settings: string;
  created_at: string;
  left_at: string | null;
}

export interface GuildChannelTable {
  guild_id: string;
  provider: string;
  channel_id: string;
}

export interface SourceTable {
  id: string;
  provider: string;
  external_id: string;
  display_name: string;
  handle: string;
  avatar_url: string | null;
  url: string;
  last_polled_at: string | null;
  last_error: string | null;
  created_at: string;
}

export interface SubscriptionTable {
  id: string;
  guild_id: string;
  source_id: string;
  channel_id: string | null;
  role_id: string | null;
  template: string | null;
  filters: string | null;
  state: SubscriptionState;
  created_by: string;
  created_at: string;
}

export interface SeenItemTable {
  source_id: string;
  item_id: string;
  kind: string;
  payload: string;
  first_seen_at: string;
}

export interface DeliveryTable {
  id: string;
  subscription_id: string;
  item_id: string;
  status: DeliveryStatus;
  attempts: number;
  next_attempt_at: string;
  last_error: string | null;
  discord_message_id: string | null;
  created_at: string;
  sent_at: string | null;
}

export interface MetaTable {
  key: string;
  value: string;
}

export interface Database {
  guild: GuildTable;
  guild_channel: GuildChannelTable;
  source: SourceTable;
  subscription: SubscriptionTable;
  seen_item: SeenItemTable;
  delivery: DeliveryTable;
  meta: MetaTable;
}

export interface GuildSettings {
  crosspost: boolean;
}

export const DEFAULT_GUILD_SETTINGS: GuildSettings = { crosspost: true };

export interface SubscriptionFilters {
  kinds: string[];
}
