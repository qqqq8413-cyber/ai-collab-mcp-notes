# Security Policy

## Supported versions

CHIEF is currently pre-release. Security fixes apply to the active CHIEF
development line, not to any specific branch name as a permanent commitment
— there are currently no maintained release branches and no backport
guarantees. Once versioned releases exist, supported versions will be
listed here explicitly.

## Reporting a vulnerability

Please report security issues privately using GitHub Security Advisories for
this repository — the "Report a vulnerability" button under the repo's
**Security** tab — rather than opening a public issue or pull request.

Include:

- A description of the issue and its potential impact.
- Steps to reproduce, or a minimal example.
- The affected file(s)/commit, if known.

There's no formal SLA, but reports will be acknowledged and looked at as
soon as possible. Please give the maintainer a reasonable window to address
an issue before any public disclosure.

## Scope notes

This project makes outbound calls to third-party model providers (OpenAI,
Anthropic, Google) using API keys supplied via environment variables or a
local `.env` file. Those keys are never read from, or written into, this
repository — if you find a code path that would log, echo, or persist a
provider API key, that's a valid report under this policy.
