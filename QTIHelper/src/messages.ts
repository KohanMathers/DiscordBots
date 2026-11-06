export const MESSAGES = {
  'bot.pong': 'Pong! Gateway latency: {ms}ms',
  'bot.hello': 'Hello {name}!',
  'member.whoami': "You're {name}, of course!",
  'member.time': 'You have been in this server for `{days}` days and `{hours}` hours.',
  'member.timeOther': '{name} has been in this server for `{days}` days and `{hours}` hours.',
  'member.position': 'You were number **{n}** to join this server.',
  'member.positionOther': '{name} was number **{n}** to join this server.',
  'member.positionUnknown': "Join position isn't available yet; the member index is still being built.",
  'member.count': "This server has `{n}` members, that's a lot of people!",
  'lock.already': 'Channel {channel} is already locked.',
  'lock.done': 'Channel {channel} has been locked.',
  'lock.notLocked': 'Channel {channel} is not locked.',
  'lock.unlocked': 'Channel {channel} has been unlocked.',
  'lock.parent': '(You ran this in a thread, so I applied it to its parent channel.)',
  'lock.notice': '🔒 This channel has been locked by a moderator.',
  'lock.noticeUnlocked': '🔓 This channel has been unlocked.',
  'purge.positive': 'Amount must be a positive number.',
  'purge.done': 'Deleted {n} messages.',
  'ar.exists': 'Autoresponse already exists, please remove it before adding another.',
  'ar.added': 'Autoresponse `{keyword}` added: {response}',
  'ar.removed': 'Autoresponse `{keyword}` removed.',
  'ar.missing': 'Autoresponse does not exist, check your spelling and try again.',
  'ar.notFound': 'Autoresponse not found.',
  'schedule.exists': 'Scheduled message already exists, please remove it before adding another.',
  'schedule.created': 'Scheduled message "{message}" to send in {channel} at {time} on {date} {tz}',
  'perm.need': 'You need the {perm} permission to {action}.',
  'help.title': 'Commands List',
  'help.footer': 'Use /help to display a list of commands.',
  'fun.intro': "Some say {fact1}, and {fact2}... all we know is, they're called {name}!",
  'fun.tonight': 'Tonight... {slot1}, {slot2}, and {slot3}.',
  'error.serverOnly': 'This command only works in a server.',
  'error.internal': "Something went wrong on my end. Try again, and if it keeps happening tell the bot's support server",
} as const;

export type MessageKey = keyof typeof MESSAGES;

let overrides: Partial<Record<MessageKey, string>> = {};

export function setMessageOverrides(o: Partial<Record<MessageKey, string>>): void {
  overrides = o;
}

export function t(key: MessageKey, vars: Record<string, string | number> = {}): string {
  const template: string = overrides[key] ?? MESSAGES[key];
  return template.replace(/\{(\w+)\}/g, (m, k: string) => (k in vars ? String(vars[k]) : m));
}
