/**
 * Common types for the `declaragent fleet render` subcommand.
 *
 * Renderers are **pure**: given a {@link LoadedFleet} and
 * {@link RenderOptions}, they return an array of
 * {@link RenderedFile}s in a stable, deterministic order. The CLI
 * wrapper (`fleet-render-cli.ts`) writes those files to disk, but tests
 * assert on the in-memory array and snapshot the concatenated output.
 *
 * Determinism rules every renderer must follow (§3 #9 Acceptance 3):
 *
 * - No timestamps, random values, or absolute host paths in the output.
 * - All maps / sets that become YAML keys are iterated in lexical order.
 * - File list itself is sorted by {@link RenderedFile.path}.
 * - YAML numbers / booleans / strings must round-trip identically —
 *   prefer `yaml`'s `stringify` with `lineWidth: 0` which is stable.
 *
 * @since 0.6.x (Enterprise plan item #9 — GitOps render)
 */

export type RenderTarget = 'k8s' | 'helm';

/**
 * Output format for the `kubernetes` render target. `helm` (default)
 * emits a Helm chart; `kustomize` emits a Kustomize base + per-env
 * overlays. Both produce byte-identical ConfigMaps / Deployments —
 * the format only changes the packaging wrapper.
 *
 * @since 0.7.5 (post-enterprise backlog #33)
 */
export type RenderFormat = 'helm' | 'kustomize';

export interface RenderedFile {
  /** Path relative to the `--out` dir. Always POSIX-style `/`-separated. */
  readonly path: string;
  readonly contents: string;
}

export interface RenderOptions {
  /**
   * Container image to set on every Deployment. Defaults to a
   * placeholder `declaragent/<agent-id>:latest` so the output is
   * inspectable without requiring operators to supply an image up
   * front. Helm exposes this via `values.yaml` too.
   */
  readonly image?: string;
  /**
   * Replica count for every agent's Deployment. Defaults to 1. Per-agent
   * `deploy.minInstances` / `maxInstances` override this when present.
   */
  readonly replicas?: number;
  /**
   * Kubernetes namespace stamped on every resource. Defaults to the
   * fleet's `manifest.name` sanitized for DNS-1123 label rules.
   */
  readonly namespace?: string;
  /**
   * Emit a ServiceMonitor per agent (assumes Prometheus Operator is
   * installed on the target cluster). Defaults to `true`. Operators on
   * vanilla Prometheus / kube-prometheus-stack-less clusters can set
   * `false` to skip the CRD.
   */
  readonly serviceMonitor?: boolean;
  /**
   * Port exposed by the declaragent runtime for `/metrics` +
   * `/healthz`. Currently hard-coded to 9464 (the Prometheus exporter
   * port baked into the runtime). Exposed here for future overrides.
   */
  readonly metricsPort?: number;
  /** HTTP probe path. Defaults to `/healthz`. */
  readonly healthProbePath?: string;
  /**
   * Split per-agent config into dedicated ConfigMaps (`<agent>-channels-config`,
   * `<agent>-sources-config`, `<agent>-plugins-config`) mounted via
   * `envFrom`. Defaults to `false` — today's monolithic ConfigMap that
   * embeds the entire `agent.yaml` is preserved so pre-0.7.5 GitOps
   * repos don't churn. Operators opt in via `--config-split` when they
   * want to rotate channel/source/plugin config without rebuilding the
   * image. A future minor may flip the default.
   *
   * @since 0.7.5 (post-enterprise backlog #32)
   */
  readonly configSplit?: boolean;
}

/**
 * Resolve {@link RenderOptions} into a fully-populated config with
 * every field non-optional. Keeps renderers total and test-friendly.
 */
export interface ResolvedRenderOptions {
  readonly image: string;
  readonly replicas: number;
  readonly namespace: string;
  readonly serviceMonitor: boolean;
  readonly metricsPort: number;
  readonly healthProbePath: string;
  readonly configSplit: boolean;
}

export function resolveRenderOptions(
  fleetName: string,
  opts: RenderOptions = {},
): ResolvedRenderOptions {
  return {
    image: opts.image ?? 'declaragent/agent:latest',
    replicas: opts.replicas ?? 1,
    namespace: opts.namespace ?? sanitizeDns1123Label(fleetName),
    serviceMonitor: opts.serviceMonitor ?? true,
    metricsPort: opts.metricsPort ?? 9464,
    healthProbePath: opts.healthProbePath ?? '/healthz',
    configSplit: opts.configSplit ?? false,
  };
}

/**
 * Sanitize an arbitrary string to a DNS-1123 label: lowercase a–z + 0–9
 * + `-`, no leading/trailing `-`, 63-char max. Used for namespace, pod,
 * service, and label names. Every k8s identifier we emit passes through
 * this to guarantee `kubectl apply --dry-run=client` accepts the output.
 */
export function sanitizeDns1123Label(raw: string): string {
  const cleaned = raw
    .toLowerCase()
    .replace(/[^a-z0-9-]+/g, '-')
    .replace(/^-+/, '')
    .replace(/-+$/, '')
    .replace(/-+/g, '-');
  const trimmed = cleaned.slice(0, 63).replace(/-+$/, '');
  return trimmed.length > 0 ? trimmed : 'declaragent';
}

/**
 * Sanitize a string for use as a ConfigMap / Secret key — `[-._a-zA-Z0-9]`.
 * Separate from label sanitization because keys are more permissive.
 */
export function sanitizeConfigKey(raw: string): string {
  return raw.replace(/[^-._a-zA-Z0-9]+/g, '_');
}

/**
 * Extract every `${secret:<ref>}` reference from an arbitrary
 * YAML-loaded object. Duplicate detection + stable sort so renderers
 * produce byte-identical output across runs. Mirrors the helper in
 * `deploy-service-yaml.ts`, kept local to avoid a cross-module import
 * pulling in GCP-specific code.
 */
export function extractSecretRefs(value: unknown): string[] {
  const seen = new Set<string>();
  const re = /\$\{secret:([^}]+)\}/g;
  const walk = (node: unknown): void => {
    if (typeof node === 'string') {
      for (const m of node.matchAll(re)) {
        const ref = m[1]?.trim();
        if (ref && ref.length > 0) seen.add(ref);
      }
      return;
    }
    if (Array.isArray(node)) {
      for (const child of node) walk(child);
      return;
    }
    if (node && typeof node === 'object') {
      for (const child of Object.values(node as Record<string, unknown>)) walk(child);
    }
  };
  walk(value);
  return [...seen].sort();
}

/**
 * Turn a secret ref like `slack/bot_token` into the env var name the
 * runtime looks up (`SLACK_BOT_TOKEN`).
 */
export function secretRefToEnvName(ref: string): string {
  return ref
    .toUpperCase()
    .replace(/[^A-Z0-9]+/g, '_')
    .replace(/^_+/, '')
    .replace(/_+$/, '');
}
