const LOGIN = /^[a-z0-9_]{1,25}$/;

export function parseTwitchInput(raw: string): string | null {
  let s = raw.trim();
  const url = s.match(/^(?:https?:\/\/)?(?:www\.|m\.)?twitch\.tv\/([^/?#\s]+)/i);
  if (url?.[1]) s = url[1];
  s = s.replace(/^@/, '').toLowerCase();
  return LOGIN.test(s) ? s : null;
}

export function livePreviewUrl(login: string, startedAt: string): string {
  const t = Math.floor(Date.parse(startedAt) / 1000) || 0;
  return `https://static-cdn.jtvnw.net/previews-ttv/live_user_${login}-1920x1080.jpg?t=${t}`;
}
