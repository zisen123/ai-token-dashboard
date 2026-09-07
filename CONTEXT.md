# ai-token-dashboard

Aggregates token usage from local AI CLI session files into one dashboard, alongside the Sophnet channel view. Exists to answer "where did my tokens go" from two deliberate perspectives.

## Language

### Aggregation

**Source**:
The client tool a usage record is attributed to — Claude Code, Codex CLI, Grok CLI, DeepSeek Harness, etc. The main dashboard aggregates by this dimension.
_Avoid_: Provider (reserved for the model's vendor), channel, tool

**Client attribution**:
The perspective that counts usage by the client tool that initiated it. Every source's statistics in the main dashboard take this perspective.
_Avoid_: Per-tool breakdown, usage by client

**Channel billing**:
The perspective that counts usage by the billing channel that charged for it — the Sophnet panel (actual paid, CNY). The same underlying consumption intentionally appears in both client attribution and channel billing; the two are never deduplicated against each other.
_Avoid_: Billing view, actual spend view

**Estimated cost**:
USD cost computed from public list prices (LiteLLM table), uniform across all sources. Distinct from channel billing amounts.
_Avoid_: Real cost, actual cost
