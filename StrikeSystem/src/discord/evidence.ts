import { createHash, randomUUID } from 'node:crypto';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { basename, join } from 'node:path';
import { AttachmentBuilder, type Attachment } from 'discord.js';
import type { Evidence } from '../core/cases.ts';

export const safeFilename = (name: string) =>
  basename(name).replace(/[^\w.\-]+/g, '_').replace(/^\.+/, '').slice(0, 100) || 'file';

export interface DownloadReport {
  evidence: Evidence[];
  problems: string[];
}

export async function downloadAttachments(
  attachments: Attachment[],
  opts: { dir: string; maxBytes: number },
): Promise<DownloadReport> {
  const evidence: Evidence[] = [];
  const problems: string[] = [];
  const folder = join(opts.dir, randomUUID());
  for (const a of attachments) {
    const filename = safeFilename(a.name);
    if (a.size > opts.maxBytes) {
      evidence.push({ kind: 'attachment', url: a.url, filename, size: a.size });
      problems.push(`${filename} is over ${Math.round(opts.maxBytes / 1_048_576)} MB, so it's linked instead of attached.`);
      continue;
    }
    try {
      const res = await fetch(a.url, { signal: AbortSignal.timeout(20_000) });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const buf = Buffer.from(await res.arrayBuffer());
      await mkdir(folder, { recursive: true });
      const path = join(folder, filename);
      await writeFile(path, buf);
      evidence.push({ kind: 'attachment', url: a.url, filename, size: buf.length, path, sha256: createHash('sha256').update(buf).digest('hex') });
    } catch (err) {
      evidence.push({ kind: 'attachment', url: a.url, filename, size: a.size });
      problems.push(`${filename} couldn't be downloaded (${(err as Error).message}), so it's linked instead.`);
    }
  }
  return { evidence, problems };
}

export async function evidenceFiles(evidence: Evidence[]): Promise<AttachmentBuilder[]> {
  const files: AttachmentBuilder[] = [];
  for (const e of evidence) {
    if (!e.path) continue;
    try {
      files.push(new AttachmentBuilder(await readFile(e.path), { name: e.filename ?? 'file' }));
    } catch {
    }
  }
  return files;
}

export async function deleteEvidence(evidence: Evidence[]): Promise<void> {
  for (const e of evidence) if (e.path) await rm(e.path, { force: true });
}
