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
  m.describe('strikes_commands_total', 'counter', 'Commands by name and outcome');
  m.describe('strikes_cases_total', 'counter', 'Cases created by type');
  m.describe('strikes_jobs_total', 'counter', 'Outbox/scheduler jobs by type and result');
  m.describe('strikes_jobs_backlog', 'gauge', 'Pending jobs');
  m.describe('strikes_discord_errors_total', 'counter', 'Discord API errors by status');
  m.describe('strikes_gateway_ping_ms', 'gauge', 'Gateway heartbeat latency');
  return m;
}
