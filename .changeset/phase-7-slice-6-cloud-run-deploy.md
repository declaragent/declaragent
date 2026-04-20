---
'@declaragent/core': patch
---

Phase 7 slice 6: `declaragent deploy gcp-cloud-run` artifact generator.

New in `@declaragent/cli`:

- `deployGcpCloudRun(args, deps?)` — parses the user's `agent.yaml` (plus
  an adjacent `tenants.yaml` when present) and emits four artifacts under
  `.declaragent/deploy/`: `Dockerfile`, `.dockerignore`, `service.yaml`,
  and a `README.md` with the three-command "docker build → docker push →
  gcloud run services replace" runbook.
- `verifyGcpCloudRunDeploy(args, deps?)` — runs `gcloud run services
  describe` + probes the deployed daemon's `/health` endpoint. On 200
  prints the shareable URL plus a webhook-configuration snippet derived
  from `channels.yaml` (or a generic fallback). Fails gracefully when
  `gcloud` is absent from `$PATH`.
- Pure renderers in `deploy-dockerfile.ts` + `deploy-service-yaml.ts`
  that are easy to snapshot-test in isolation. `renderServiceYaml`
  stamps CPU / memory limits, `autoscaling.knative.dev/minScale` = 1 (so
  the daemon stays warm for webhooks), one env var per `${secret:...}`
  ref found anywhere in the parsed YAML, and one `volumes` +
  `volumeMounts` pair per tenant declared in `tenants.yaml`.

**Deliberately out of scope:** we do not invoke `gcloud` on the user's
behalf during generation — the three commands are printed for the user
to run themselves, so GCP auth stays theirs to own. `--verify` is the
one place we shell out, and even there we exit gracefully if the user
doesn't have `gcloud` installed yet.

**Cost note surfaced in the generated README:** $40–$60 / month (lower
bound) at the default `cpu=1, memory=512MiB, minInstances=1` preset.
Provider token costs are additive.

**Locally validated.**
- `bun run typecheck` — clean.
- `bun test packages/cli/src/deploy-cli.test.ts` — 17/0.
- `bun test packages/cli/src/deploy-service-yaml.test.ts` — 17/0.
- `bun test` — baseline unchanged on all other suites.

**Deferrals / TODOs.**
- The `deploy` subcommand is not yet wired into `index.tsx` — the
  orchestrator will handle that after reconciling with slices 7 and 8.
- A nightly Cloud Run soak that actually deploys to a scratch GCP
  project is TODO'd in `.github/workflows/cloud-run-soak.yml`; for slice
  6 the workflow asserts artifact generation only.
