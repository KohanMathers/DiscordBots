export function renameForClone(name: string, newPrefix: string): string {
  const lead = name.match(/^[^\p{L}\p{N}-]*/u)?.[0] ?? '';
  const rest = name.slice(lead.length);
  const dash = rest.indexOf('-');
  const body = dash >= 0 ? `${newPrefix}${rest.slice(dash)}` : `${newPrefix}-${rest}`;
  return `${lead}${body}`.slice(0, 100);
}

export function normaliseTextName(name: string): string {
  return name.toLowerCase().replace(/\s+/g, '-').slice(0, 100);
}
