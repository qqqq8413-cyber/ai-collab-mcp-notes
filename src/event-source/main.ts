#!/usr/bin/env node
import { loadWorkspaceConfig } from '../workspace/config.js';
import { importClaudeTranscript, type TranscriptCursor } from './claude-transcript.js';

const args = process.argv.slice(2);
function argument(name: string): string {
  const index = args.indexOf(name);
  const value = args[index + 1];
  if (index < 0 || !value || value.startsWith('--') || args.lastIndexOf(name) !== index) throw new Error(`Required: ${name}`);
  return value;
}
try {
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--watch') continue;
    if (!['--config', '--project', '--session-file', '--source-cwd'].includes(args[i])) throw new Error('Unknown argument');
    i++;
  }
  const config = loadWorkspaceConfig(argument('--config'));
  const projectId = argument('--project');
  if (!config.projects.some((p) => p.projectId === projectId)) throw new Error('Project not configured');
  const file = argument('--session-file');
  const sourceCwd = argument('--source-cwd');
  let previous: TranscriptCursor | undefined;
  const tick = () => {
    const result = importClaudeTranscript({ file, sourceCwd, projectId, dataDirectory: config.dataDirectory, previous });
    previous = result.cursor;
    if (result.added || result.duplicates || !args.includes('--watch')) {
      console.log(JSON.stringify({ projectId, source: 'CLAUDE_CODE_LOCAL_TRANSCRIPT', added: result.added,
        duplicates: result.duplicates, ignored: result.ignored, incompleteBytes: result.incompleteBytes }));
    }
  };
  tick();
  if (args.includes('--watch')) {
    console.log('觀察模式：首次讀取是歷史匯入；後續新增為監看收到的紀錄。不啟動 AI，也不是執行授權。');
    const timer = setInterval(() => {
      try { tick(); } catch (error) {
        clearInterval(timer);
        console.error(error instanceof Error && error.name !== 'ZodError' ? error.message : 'Invalid event input; monitoring stopped');
        process.exitCode = 1;
      }
    }, 2000);
    process.once('SIGINT', () => clearInterval(timer));
    process.once('SIGTERM', () => clearInterval(timer));
  }
} catch (error) {
  // Never print Zod's raw input or transcript content.
  console.error(error instanceof Error && error.name !== 'ZodError' ? error.message : 'Invalid event input; nothing imported');
  process.exitCode = 1;
}
