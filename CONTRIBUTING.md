# Contributing

Thanks for your interest in this project. It's a personal / research-stage
codebase, so please open an issue to discuss any non-trivial change before
sending a pull request — that avoids wasted work on either side.

## Getting started

```sh
npm ci
npm test
```

`npm test` compiles TypeScript and runs the full offline test suite. None of
it calls a live model API or needs any API key.

A few scripts are intentionally excluded from `npm test` because they call
live provider APIs (`test-simple-baseline.mjs`, `test-orchestrator.mjs`, and
similar `*-live.mjs` harnesses referenced in [HANDOFF.md](HANDOFF.md)). You
don't need them, and shouldn't run them, to contribute — they require paid
API keys and are only used for the maintainer's own live-regression checks.

## Making a change

- Keep pull requests scoped to one change. Unrelated cleanup makes review
  harder, not easier.
- Add or update tests for any behavior change. This project relies on its
  offline test suite as the acceptance bar, not manual verification.
- Don't modify files under `diagnostics/` or `regressions/` — those are
  captured evidence from specific runs, not editable fixtures.
- Follow the existing TypeScript/ESM style already in `src/`.

## Project background

[HANDOFF.md](HANDOFF.md) is the running development log and has far more
context than this file — architecture rationale, what's been tried, what's
explicitly deferred. Read it before proposing a design change; it will
usually save you from re-litigating a decision that's already been made and
recorded there.

## Reporting bugs

Open a GitHub issue with steps to reproduce. If it's a security issue, see
[SECURITY.md](SECURITY.md) instead — don't open a public issue for that.

## License

By contributing, you agree that your contributions will be licensed under
this project's [Apache License 2.0](LICENSE).
