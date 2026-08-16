---
"@declaragent/cli": patch
---

`fleet deploy` gains its first real adapter (WS6): **`createKubectlDeployTarget`**, registered by default for `deploy.targets{}.<key>.kind: kubectl`. It deploys the `fleet render --target k8s` output per agent — `kubectl apply` the agent manifest (namespace manifest first), stamp `DECLARAGENT_FLEET_VERSION` (+ injected env) via `kubectl set env`, then block on `kubectl rollout status`; health checks read `availableReplicas`, rollback is `kubectl rollout undo`. Config keys pass through fleet.yaml: `renderDir` (default `./render`), `namespace` (default fleet name), `context`, `rolloutTimeoutSec`. Verified live on minikube: `declaragent fleet deploy --target k8s` brought up a two-agent fleet with rolling strategy, per-agent rollout waits, artifact reporting, and the deploy history ledger. The kubectl shell-out is injectable, so the adapter is fully unit-tested without a cluster.
