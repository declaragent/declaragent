import { stringify as stringifyYaml } from 'yaml';

export interface ServiceYamlTenant {
  id: string;
}

export interface ServiceYamlConfig {
  serviceName: string;
  project: string;
  region: string;
  cpu: number;
  memoryMib: number;
  minInstances: number;
  maxInstances?: number;
  concurrency?: number;
  /** Bare refs without the `${secret:...}` wrapper — e.g. `["slack/bot_token", "vault/api_key"]`. */
  secretRefs: readonly string[];
  /** Tenant ids declared in `tenants.yaml`; one volume mount is emitted per entry. */
  tenants: ReadonlyArray<ServiceYamlTenant>;
  /** Image reference injected into `spec.template.spec.containers[0].image`. */
  image?: string;
}

/**
 * Sanitize an identifier to Cloud Run service-name rules: lowercase, `-`
 * separated, alphanumeric only. 49-char cap matches the Cloud Run limit.
 */
export function sanitizeServiceName(raw: string): string {
  const cleaned = raw
    .toLowerCase()
    .replace(/[^a-z0-9-]+/g, '-')
    .replace(/^-+/, '')
    .replace(/-+$/, '')
    .replace(/-+/g, '-');
  const trimmed = cleaned.slice(0, 49).replace(/-+$/, '');
  return trimmed.length > 0 ? trimmed : 'declaragent';
}

/** Turn a secret ref like `slack/bot_token` into a GCP-safe suffix. */
export function normalizeSecretRef(ref: string): string {
  return ref
    .toLowerCase()
    .replace(/[^a-z0-9-]+/g, '-')
    .replace(/^-+/, '')
    .replace(/-+$/, '')
    .replace(/-+/g, '-');
}

/** Turn a secret ref into the ENV VAR name the daemon will look up. */
export function secretRefToEnvName(ref: string): string {
  return ref
    .toUpperCase()
    .replace(/[^A-Z0-9]+/g, '_')
    .replace(/^_+/, '')
    .replace(/_+$/, '');
}

/** Extract every `${secret:...}` reference from an arbitrary YAML-loaded object. */
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

interface ContainerEnv {
  name: string;
  valueFrom: { secretKeyRef: { name: string; key: string } };
}

interface ContainerVolumeMount {
  name: string;
  mountPath: string;
  readOnly?: boolean;
}

interface ServiceVolume {
  name: string;
  emptyDir: { medium?: string; sizeLimit?: string };
}

export function renderServiceYaml(cfg: ServiceYamlConfig): string {
  const service = sanitizeServiceName(cfg.serviceName);
  const image = cfg.image ?? `gcr.io/${cfg.project}/${service}:latest`;

  const env: ContainerEnv[] = cfg.secretRefs.map((ref) => ({
    name: secretRefToEnvName(ref),
    valueFrom: {
      secretKeyRef: {
        name: `${service}-${normalizeSecretRef(ref)}`,
        key: 'latest',
      },
    },
  }));

  const volumeMounts: ContainerVolumeMount[] = cfg.tenants.map((t) => ({
    name: `tenant-${normalizeSecretRef(t.id)}`,
    mountPath: `/etc/declaragent/tenants/${t.id}`,
  }));

  const volumes: ServiceVolume[] = cfg.tenants.map((t) => ({
    name: `tenant-${normalizeSecretRef(t.id)}`,
    emptyDir: { sizeLimit: '256Mi' },
  }));

  const annotations: Record<string, string> = {
    'autoscaling.knative.dev/minScale': String(cfg.minInstances),
    'run.googleapis.com/execution-environment': 'gen2',
  };
  if (cfg.maxInstances !== undefined) {
    annotations['autoscaling.knative.dev/maxScale'] = String(cfg.maxInstances);
  }

  const container: Record<string, unknown> = {
    image,
    ports: [{ name: 'http1', containerPort: 8787 }, { containerPort: 9464 }],
    resources: {
      limits: {
        cpu: String(cfg.cpu),
        memory: `${cfg.memoryMib}Mi`,
      },
    },
  };
  if (env.length > 0) container.env = env;
  if (volumeMounts.length > 0) container.volumeMounts = volumeMounts;

  const templateSpec: Record<string, unknown> = {
    serviceAccountName: `${service}-sa`,
    containers: [container],
  };
  if (cfg.concurrency !== undefined) templateSpec.containerConcurrency = cfg.concurrency;
  if (volumes.length > 0) templateSpec.volumes = volumes;

  const doc = {
    apiVersion: 'serving.knative.dev/v1',
    kind: 'Service',
    metadata: {
      name: service,
      labels: { 'declaragent.io/service': service },
    },
    spec: {
      template: {
        metadata: { annotations },
        spec: templateSpec,
      },
      traffic: [{ percent: 100, latestRevision: true }],
    },
  };

  return stringifyYaml(doc, { lineWidth: 0 });
}
