import { constants, closeSync, fstatSync, openSync, readFileSync, realpathSync } from 'node:fs';
import { basename, resolve } from 'node:path';
import { z } from 'zod';
import { FileCollaborationStore, hash, observationId, type ObservedEvent } from '../workspace/collaboration-store.js';

const assistantSchema = z.object({
  type: z.literal('assistant'), uuid: z.string().uuid(), sessionId: z.string().uuid(), timestamp: z.iso.datetime(),
  cwd: z.string().min(1), isSidechain: z.boolean().optional(),
  message: z.object({ role: z.literal('assistant'), content: z.array(z.object({ type: z.string() }).passthrough()) }),
});
export interface TranscriptCursor { readonly device: number; readonly inode: number; readonly bytes: number; readonly prefixHash: string }
export interface TranscriptImportOptions {
  file: string; sourceCwd: string; projectId: string; dataDirectory: string;
  previous?: TranscriptCursor; now?: string;
}

/** Explicit local file, not a hook or a model call. Only public assistant text is selected. */
export function importClaudeTranscript(options: TranscriptImportOptions) {
  const sessionId = basename(options.file, '.jsonl');
  z.string().uuid().parse(sessionId);
  if (!options.file.endsWith('.jsonl')) throw new Error('Select a Claude session .jsonl file');
  const expectedCwd = realpathSync(resolve(options.sourceCwd));
  const fd = openSync(options.file, constants.O_RDONLY | constants.O_NOFOLLOW);
  let data: Buffer, stat;
  try {
    stat = fstatSync(fd);
    if (!stat.isFile() || stat.size > 64 * 1024 * 1024) throw new Error('Source must be a regular file of at most 64 MiB');
    data = readFileSync(fd);
    if (data.length > 64 * 1024 * 1024) throw new Error('Source grew beyond its limit');
  } finally { closeSync(fd); }
  const previous = options.previous;
  if (previous && (previous.device !== stat.dev || previous.inode !== stat.ino || data.length < previous.bytes ||
      hash(data.subarray(0, previous.bytes).toString('utf8')) !== previous.prefixHash)) {
    throw new Error('Watched source was replaced, truncated or rewritten; monitoring stopped');
  }
  // A producer may still be writing its last JSON line. It is not an event until newline-complete.
  const end = data.lastIndexOf(10) + 1;
  const start = previous?.bytes ?? 0;
  const text = data.subarray(start, end).toString('utf8');
  const events: ObservedEvent[] = [];
  let ignored = 0;
  const receivedAt = z.iso.datetime().parse(options.now ?? new Date().toISOString());
  for (const line of text.split('\n').filter((s) => s.trim())) {
    let row: unknown;
    try { row = JSON.parse(line); } catch { throw new Error('Malformed complete source line; batch not imported'); }
    if (!row || typeof row !== 'object' || Array.isArray(row) || !('type' in row) || typeof row.type !== 'string') {
      throw new Error('Invalid source record; batch not imported');
    }
    if (row.type !== 'assistant') { ignored++; continue; }
    const parsed = assistantSchema.parse(row);
    if (parsed.sessionId !== sessionId || realpathSync(resolve(parsed.cwd)) !== expectedCwd) {
      throw new Error('Assistant session or working directory does not match the selected source');
    }
    if (parsed.isSidechain) { ignored++; continue; }
    for (const [blockIndex, block] of parsed.message.content.entries()) {
      if (block.type !== 'text') { ignored++; continue; }
      if (typeof block.text !== 'string') throw new Error('Malformed assistant text; batch not imported');
      const originalText = block.text;
      // Display transformation only: preserve text hash; tabs/CRLF become readable spaces/LF.
      const body = originalText.replace(/\r\n/g, '\n').replace(/\t/g, '    ');
      if (!body.trim()) { ignored++; continue; }
      if (/[\u0000-\u0009\u000b-\u001f\u007f]/.test(body)) throw new Error('Control characters in assistant text');
      const parts: string[] = [];
      let part = '';
      for (const char of body) {
        if (part.length + char.length > 4000) { parts.push(part); part = ''; }
        part += char;
      }
      if (part) parts.push(part);
      // Whitespace-only parts cannot pass the room model; refuse rather than silently drop text.
      if (parts.some((s) => !s.trim())) throw new Error('Text segment contains only whitespace');
      parts.forEach((chunk, partIndex) => events.push({
        id: observationId(options.projectId, sessionId, parsed.uuid, blockIndex, partIndex), projectId: options.projectId,
        actor: 'Claude Code', actorId: 'claude-code', runtime: 'Claude Code', type: 'RESPONSE', body: chunk,
        timestamp: parsed.timestamp,
        observation: { source: 'CLAUDE_CODE_LOCAL_TRANSCRIPT', sessionId, eventId: parsed.uuid, eventType: 'assistant.text',
          receivedAt, captureMode: previous ? 'LIVE_TAIL' : 'HISTORY', blockIndex, partIndex, partCount: parts.length, textHash: hash(originalText) },
      }));
    }
  }
  const result = new FileCollaborationStore(options.dataDirectory).merge(options.projectId, events);
  return { ...result, ignored, incompleteBytes: data.length - end,
    cursor: { device: stat.dev, inode: stat.ino, bytes: end, prefixHash: hash(data.subarray(0, end).toString('utf8')) } satisfies TranscriptCursor };
}
