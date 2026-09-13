# Provenance

`SKILL.md` is a verbatim copy of the `frontend-design` skill from the
`frontend-design` plugin in [anthropics/claude-code](https://github.com/anthropics/claude-code).

- Upstream path: `plugins/frontend-design/skills/frontend-design/SKILL.md`
- Plugin version: 1.1.0
- Copied from commit: b5932767f3acbd07da25367064827e5cb81f43de
- sha256: d91970639e9f5c37682ac7ab60094d35f1c7c1f38d731bd56396563aee10c1d3

Vendored here rather than installed via `/plugin` because `/plugin` is a local
CLI feature and is not available in Claude Code on the web; a skill committed to
`.claude/skills/` loads in every session that opens this repository.

The skill's own frontmatter points at `LICENSE.txt`, which does not exist in the
upstream plugin directory. The governing terms are the repository-level
[LICENSE.md](https://github.com/anthropics/claude-code/blob/main/LICENSE.md):
© Anthropic PBC, use subject to Anthropic's Commercial Terms of Service.

To refresh, re-copy the upstream file and update the commit and checksum above.
