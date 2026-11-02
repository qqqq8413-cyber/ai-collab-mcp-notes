# M2-0 SUBSCRIPTION AUTOMATION MVP — Implementer report

Base `ec4dfd5b89be60262833d6409a7c063e90ae066d` (EXE = HOLD). Branch `work/m2-0-subscription-automation`.
The exact SHA is the commit that adds this file (stated in HANDOFF and in the paste block; a commit cannot name its own SHA).

## What it does

The Human types a task in the CHIEF Workspace (自動化 → 交給 Claude Code). The Human's own official Claude Code,
signed in with the Human's Claude Pro subscription, connects to a local CHIEF MCP server, claims the task, reads the
repository read-only, and writes the report back through MCP. The Workspace polls every 3 s and shows
PENDING → RUNNING → COMPLETED (or FAILED / CANCELLED) and the report. No copy-paste of tasks or results.

CHIEF never calls a model, never reads, creates or passes an API key or token, never starts Claude Code by itself,
and never touches the M1 governed Worker, the Authority Archive or EXE (still HOLD; the M1 LIVE API NO-GO is kept).

## Push understanding (as instructed)

"不自動推送 Git" in M2-0 is read as: the MVP system itself never pushes Git (nothing in `src/subscription` runs git
except `git rev-parse HEAD` to record the task's source commit). The Implementer pushed this work branch with
`chief-ai-bot`, as usual, to run CI and fix an exact SHA. main was not touched.

## Files

New:
- `src/subscription/contract.ts` — tool names, states, limits, billing-variable names, task rules, the processing prompt.
- `src/subscription/task-store.ts` — the task ledger (private dir, locked + checksummed atomic writes; claim = PENDING→RUNNING once, with a random claimId).
- `src/subscription/mcp-server.ts`, `src/subscription/mcp-main.ts` — the CHIEF MCP server (stdio), four tools.
- `src/subscription/workspace-port.ts`, `src/workspace/subscription-task-port.ts` — Workspace side: add / read / cancel only.
- `src/subscription/host.ts`, `src/subscription/main.ts` — M2 Host (`npm run workspace:m2`): Workspace + queue, writes the MCP config.
- `src/subscription/launcher.ts`, `src/subscription/process-once.ts` — "process once" launcher (`npm run m2:process-once`).
- `src/subscription/layout.ts` — data directory layout and checks.
- `workspace-ui/subscription-tasks.js` — the UI panel.
- `test-m2-subscription-automation.mjs` — non-paid end-to-end tests (in `test:pilot`, so in `npm test`).

Changed:
- `src/workspace/server.ts` — three routes `GET|POST /api/v0/projects/:projectId/subscription-tasks`, `POST …/subscription-tasks/:taskId/actions` (CANCEL only); 503 when the Host has no queue.
- `workspace-ui/automation.js` (mounts the panel first; header now says `API 執行 · HOLD`), `workspace-ui/live.js` (three calls), `workspace-ui/styles.css` (command blocks wrap).
- `package.json` — scripts `workspace:m2`, `m2:mcp`, `m2:process-once`; test added to `test:pilot`.
- `test-workspace-ui.mjs` — route count 21 → 24 and the live-source key list (the three new routes are asserted exactly).

## MCP tools (server name `chief-tasks`)

| Tool | Input | Effect |
|---|---|---|
| `chief_next_task` | none | Oldest PENDING task (`TASK_AVAILABLE` with taskId, objective, source, rules) or `NO_PENDING_TASK`. Does not reserve. Idle polls closer than 5 s without a claim in between answer `RATE_LIMITED`. |
| `chief_claim_task` | `taskId` (uuid) | PENDING → RUNNING exactly once; returns `claimId`. Otherwise `TASK_NOT_PENDING`. At most 5 claims per Claude Code session (`SESSION_TASK_LIMIT`). |
| `chief_complete_task` | `taskId`, `claimId`, `report` (1..65,536 bytes Markdown) | RUNNING → COMPLETED with the report and its SHA-256. Wrong claimId `CLAIM_MISMATCH`; not RUNNING `TASK_NOT_RUNNING`. |
| `chief_fail_task` | `taskId`, `claimId`, `reason` (`[A-Z0-9_]{1,64}`), `detail` (≤500) | RUNNING → FAILED with the reason. No retry. |

Each task: `taskId`, `projectId`, `objective`, `state` (PENDING / RUNNING / COMPLETED / FAILED / CANCELLED), `createdAt`,
`createdBy`, `source` {repository, workingDirectory (repo root), commitSha (HEAD when created), readme: README.md},
`claim` {claimId, claimedAt, worker}, `finishedAt`, `report`, `reportSha256`, `failure`, `events`.

No tool takes a path, command, URL, credential, Authority, Git or deployment input. The server reads and writes only
its task ledger; it imports no provider SDK, governed Worker, Controller or Authority module and spawns nothing.
If any billing variable is present in its environment, every tool answers `BILLING_GUARD_API_ENV_PRESENT`.

## Billing and compliance guards

- Billing variables (presence only; values never read or printed): `ANTHROPIC_API_KEY`, `ANTHROPIC_AUTH_TOKEN`,
  `ANTHROPIC_BASE_URL`, `CLAUDE_CODE_OAUTH_TOKEN`, `CLAUDE_CODE_USE_BEDROCK`, `CLAUDE_CODE_USE_VERTEX`,
  `CLAUDE_CODE_USE_FOUNDRY`. The launcher refuses to start Claude Code; the MCP server refuses every tool.
- Login check before Claude Code starts: `claude auth status --json` must show `loggedIn: true`,
  `authMethod: "claude.ai"`, `apiProvider: "firstParty"`, no `apiKeySource`, `subscriptionType` `pro` or `max`.
  Anything else, or unreadable output, refuses (no silent switch to API billing). Only these fields are printed
  (never email or organization). The field values were read from the Claude Code 2.1.283 binary's own
  `auth status` code (`authMethod` ∈ claude.ai / api_key_helper / oauth_token / api_key / third_party / none).
- An empty queue never starts Claude Code (no quota used).
- Claude Code flags (all in `claude --help` of 2.1.283): `-p`, `--restricted` (no code-running tools; ignores
  user/project/local settings, so no apiKeyHelper, hooks or plugins), `--tools Read,Glob,Grep`,
  `--permission-mode dontAsk`, `--permission-prompts none`, `--settings` with allow = the four CHIEF tools +
  `Read(./**)`, Glob, Grep and deny = credential locations (`~/.ssh`, `~/.aws`, `~/.config`, `~/.gnupg`, `~/.claude`,
  `~/.claude.json`, `~/.netrc`, `~/.npmrc`, `~/Library`, `./.git`, `.env*`) + Bash/Edit/Write/NotebookEdit/WebFetch/WebSearch,
  `disableBypassPermissionsMode: "disable"`, `--mcp-config <data>/claude-mcp.json --strict-mcp-config`,
  `--disable-slash-commands`, `--no-chrome`, `--no-session-persistence`. Never `--bare`,
  `--dangerously-skip-permissions`, bypassPermissions or a key. The prompt goes on stdin. 30-minute stop.
- The Human must turn off claude.ai "extra usage" and confirm the login method (see below); CHIEF cannot see either.

## Human acceptance steps (Dawn, once, with the Pro subscription)

Use the normal macOS Terminal app (the Claude app's own terminal carries `ANTHROPIC_BASE_URL`, which the guard refuses).

1. Window A — start CHIEF:
   `cd ~/Documents/CHIEF-UI1/wt-m2 && git rev-parse HEAD && npm run build && npm run workspace:m2 -- --data-dir "$HOME/Documents/CHIEF-UI1/m2-data"`
   Open `http://localhost:4880/#/p/chief/automation`.
2. Window B — evidence (paste the output; no secrets in it):
   `env | cut -d= -f1 | grep -E '^(ANTHROPIC|CLAUDE_CODE_(OAUTH|USE))' ; echo "billing vars checked"`
   `claude auth status --json | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{const j=JSON.parse(s);console.log({loggedIn:j.loggedIn,authMethod:j.authMethod,apiProvider:j.apiProvider,subscriptionType:j.subscriptionType,apiKeySource:j.apiKeySource??"none"})})'`
   And a screenshot of claude.ai → Settings → Usage showing extra usage off.
3. In the UI type the acceptance task and press 建立任務 → the card shows `PENDING · 等待 Claude Code 領取`.
4. Window B: `cd ~/Documents/CHIEF-UI1/wt-m2 && npm run m2:process-once -- --data-dir "$HOME/Documents/CHIEF-UI1/m2-data"`
5. Watch the UI: `RUNNING · Claude Code 處理中`, then `COMPLETED · 已完成` with the report.
6. Run step 4 again: it must say `CHIEF 沒有待辦任務；沒有啟動 Claude Code` (no duplicate run).

Optional continuous mode: `claude mcp add chief-tasks --scope local -- <node> <repo>/dist/subscription/mcp-main.js --data-dir <data>`
(the exact line is shown in the UI), then `claude`, then `/loop 10m <prompt shown in the UI>`. Each loop turn uses a little
Pro quota even when the queue is empty.

## Tests (no real `claude`, no model, no key)

`test-m2-subscription-automation.mjs`, 12 checks: the acceptance flow over HTTP + the real stdio MCP server
(PENDING → RUNNING → README actually read → report → COMPLETED, nothing re-offered); a three-session claim race
(exactly one wins; stolen claimIds refused); failure path; Human cancel; idle-poll limit and session claim limit;
MCP billing guard (value never shown); MCP surface + module graph (four tools, five input fields, no provider /
governed / Authority import, no child process, EXE still HOLD); launcher refusals (billing variables, API-key,
api_key_helper, oauth_token, bedrock, team, not logged in, missing config, empty queue) with a stand-in `claude`
on a private PATH; launcher end to end (the stand-in reads the prompt on stdin, starts the MCP server from
`--mcp-config`, works two tasks to COMPLETED; exact argv asserted); Host (private MCP config, data dir outside the
repo, M0/M1 Worker not composed, origin/header/strict input); store (tamper, size, stuck lock, restart); UI.

## Not proven

- No real Claude Code run yet: that `--restricted` + `--tools` + `dontAsk` + `--settings` together still let a
  subscription-logged-in `claude -p` call the CHIEF MCP tools and read `README.md`; that the deny rules cover
  Glob/Grep; whether Claude Code passes its environment to the MCP server (the launcher check is the primary guard).
- That `claude -p` usage draws only from the Pro allowance: depends on the account; the Human's
  `auth status` evidence and the extra-usage-off screenshot are the evidence, not this code.
- The read deny list is a list, not a sandbox: a credential stored somewhere not listed and inside a readable place
  is not covered by a rule (tasks come only from the local Human; the prompt forbids it).
- `/loop` behaviour on 2.1.283 (exists in the binary; not run).
- A RUNNING task whose Claude Code died stays RUNNING until the Human cancels it (by design: no automatic re-run).
- A leftover `write.lock` (process killed mid-write) stops writes until the Human removes it (fail closed).
