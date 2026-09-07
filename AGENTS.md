# AGENTS.md

Agent-facing documentation for this repository. Equals CLAUDE.md in effect (see the global instruction).

## Agent skills

### Issue tracker

Issues and specs live as GitHub issues, driven via the `gh` CLI. See `docs/agents/issue-tracker.md`.

### Triage labels

Five canonical roles map to the default label strings (`needs-triage`, `needs-info`, `ready-for-agent`, `ready-for-human`, `wontfix`). See `docs/agents/triage-labels.md`.

### Domain docs

Single-context — one `CONTEXT.md` + `docs/adr/` at the repo root. See `docs/agents/domain.md`.
