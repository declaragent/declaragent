---
'@declaragent/cli': patch
---

Wire `declaragent fleet run` to the real LLM engine (Phase A.2 of USABILITY_PLAN.md). Previously the multi-agent dev loop echoed every capability request via a slice-3 stub; now each scaffolded agent loads its `agent.yaml` + `skills/`, builds a per-agent extension registry, and answers RPC calls by running the matching skill against a real engine turn. Tests that want a deterministic no-LLM path keep working via `deps.makeHandler = () => defaultHandler`.
