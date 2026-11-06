type Labels = Record<string, string | number>;

const keyOf = (name: string, labels?: Labels): string => {
  if (!labels || Object.keys(labels).length === 0) return name;
  const parts = Object.entries(labels)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([k, v]) => `${k}="${String(v).replace(/["\\\n]/g, '_')}"`);
  return `${name}{${parts.join(',')}}`;
};

export class Metrics {
  private readonly counters = new Map<string, number>();
  private readonly gauges = new Map<string, number>();
  private readonly help = new Map<string, { type: 'counter' | 'gauge'; text: string }>();

  describe(name: string, type: 'counter' | 'gauge', text: string): void {
    this.help.set(name, { type, text });
  }

  inc(name: string, labels?: Labels, by = 1): void {
    const k = keyOf(name, labels);
    this.counters.set(k, (this.counters.get(k) ?? 0) + by);
  }

  set(name: string, value: number, labels?: Labels): void {
    this.gauges.set(keyOf(name, labels), value);
  }

  get(name: string, labels?: Labels): number {
    const k = keyOf(name, labels);
    return this.counters.get(k) ?? this.gauges.get(k) ?? 0;
  }

  render(): string {
    const lines: string[] = [];
    for (const [name, h] of this.help) {
      lines.push(`# HELP ${name} ${h.text}`, `# TYPE ${name} ${h.type}`);
      const source = h.type === 'counter' ? this.counters : this.gauges;
      for (const [k, v] of source) if (k === name || k.startsWith(`${name}{`)) lines.push(`${k} ${v}`);
    }
    return `${lines.join('\n')}\n`;
  }
}

export function createMetrics(): Metrics {
  const m = new Metrics();
  m.describe('announcer_polls_total', 'counter', 'Provider poll cycles by provider and result');
  m.describe('announcer_api_errors_total', 'counter', 'External API errors by provider and HTTP status');
  m.describe('announcer_items_detected_total', 'counter', 'New items seen by provider');
  m.describe('announcer_announcements_total', 'counter', 'Announcements by result (sent, failed, retried)');
  m.describe('announcer_outbox_depth', 'gauge', 'Pending deliveries');
  m.describe('announcer_quota_units_today', 'gauge', 'API quota units used today by provider');
  return m;
}
