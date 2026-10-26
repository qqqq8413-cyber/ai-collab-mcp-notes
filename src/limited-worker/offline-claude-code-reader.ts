import { randomUUID } from 'node:crypto';
import { readFileSync, readdirSync } from 'node:fs';
import { MODEL } from './contract.js';
import { READER_GOAL_PREFIX } from './claude-code-reader.js';

// OFFLINE_SYNTHETIC stand-in for the Claude Code CLI, run only by the offline rehearsal Host's reader runner. It is
// not a model and calls nothing: it checks the read-only argv, reads the one file in its workspace and answers in
// the CLI's JSON result shape with a Traditional Chinese report that says plainly it is synthetic.

const argv = process.argv.slice(2);
const value = (flag: string) => { const i = argv.indexOf(flag); return i < 0 ? undefined : argv[i + 1]; };
const fail = (code: number, message: string): never => { process.stderr.write(`offline reader: ${message}\n`); process.exit(code); };

if (!argv.includes('-p') || value('--output-format') !== 'json' || value('--model') !== MODEL || value('--tools') !== 'Read,Glob,Grep' ||
  !value('--max-turns') || !value('--json-schema') || !(value('--disallowedTools') ?? '').includes('Bash')) fail(2, 'unexpected arguments');
const entries = readdirSync('.');
if (entries.length !== 1 || entries[0] !== 'README.md') fail(3, 'the workspace must hold README.md only');
const prompt = readFileSync(0, 'utf8');
const line = prompt.split('\n').find((text) => text.startsWith(READER_GOAL_PREFIX));
let goal = '';
try { goal = JSON.parse(line?.slice(READER_GOAL_PREFIX.length) ?? ''); } catch { fail(4, 'no goal in the prompt'); }
const text = readFileSync('README.md', 'utf8'), lines = text.split('\n');
const headings = lines.map((content, index) => ({ content, number: index + 1 })).filter(({ content }) => /^#{1,6} /.test(content)).slice(0, 20);
const quote = (s: string) => s.replace(/[\r\n]+/g, ' ').slice(0, 400);
const report = [
  '# OFFLINE_SYNTHETIC 唯讀分析報告',
  '',
  '> **OFFLINE_SYNTHETIC**：這份報告由離線合成執行檔產生，只用來驗證 CHIEF 從任務入口、Host 派工、隔離工作區執行到結果回傳的完整流程。**不是真實 Claude Code 或 AI 的分析成果，沒有呼叫任何模型。**',
  '',
  '## 任務',
  '',
  `> ${quote(goal)}`,
  '',
  '## 讀取的檔案',
  '',
  `- README.md：${Buffer.byteLength(text)} bytes、${lines.length} 行（固定版本，是隔離工作區裡唯一的檔案）`,
  '',
  '## 文件結構（標題與行號）',
  '',
  ...(headings.length ? headings.map(({ content, number }) => `- 第 ${number} 行：${quote(content.replace(/^#+\s*/, ''))}`) : ['- 沒有找到 Markdown 標題。']),
  '',
  '## 不確定事項',
  '',
  '- 這份報告只整理了檔案的結構，沒有真正理解內容；正式結論必須等真實 Claude Code 在完成授權後執行。',
].join('\n') + '\n';
const usage = { input_tokens: Math.ceil((prompt.length + text.length) / 4), output_tokens: Math.min(2048, Math.ceil(report.length / 2)),
  cache_creation_input_tokens: 0, cache_read_input_tokens: 0, service_tier: 'standard' };
process.stdout.write(JSON.stringify({ type: 'result', subtype: 'success', is_error: false, num_turns: 2, session_id: `offline-synthetic-${randomUUID()}`,
  total_cost_usd: 0, usage, modelUsage: { [MODEL]: { inputTokens: usage.input_tokens, outputTokens: usage.output_tokens } }, structured_output: { report } }));
