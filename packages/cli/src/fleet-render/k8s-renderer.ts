/**
 * Render a {@link LoadedFleet} to a set of raw Kubernetes manifests.
 *
 * Emits, per §3 #9 Scope-in:
 *
 *   - One `Namespace` for the whole fleet.
 *   - Per agent: `ConfigMap` (inline `agent.yaml`), `Deployment`,
 *     `Service` in `agents/<id>.yaml`, plus an optional
 *     `ServiceMonitor` (Prometheus Operator CRD — gated on
 *     {@link ResolvedRenderOptions.serviceMonitor}) emitted into a
 *     SEPARATE `agents/<id>-servicemonitor.yaml` file so operators on
 *     vanilla Prometheus can delete the monitor without touching the
 *     core workload manifests (#31, 0.7.3).
 *   - Per unique `${secret:<ref>}` discovered across every agent.yaml,
 *     a stub `Secret` manifest with **key-only** stringData — the
 *     operator fills in the values (§3 #9 Secret refs, not values).
 *
 * The renderer is **pure**: same input → byte-identical output. File
 * order is lexical on `path`. Inside each file, map keys iterate in
 * insertion order for the `yaml` library, so we build the objects
 * field-by-field in the order we want emitted.
 *
 * @since 0.6.x (Enterprise plan item #9)
 */

import { readFile } from 'node:fs/promises';
import type { LoadedAgentEntry, LoadedFleet } from '@declaragent/core';
import { parse as parseYaml, stringify as stringifyYaml } from 'yaml';
import {
  type RenderOptions,
  type RenderedFile,
  type ResolvedRenderOptions,
  extractSecretRefs,
  resolveRenderOptions,
  sanitizeDns1123Label,
  secretRefToEnvName,
} from './types.js';

// `aliasDuplicateObjects: false` disables `&a1` / `*a1` anchor emission
// for repeated objects (e.g. labels vs selector.matchLabels). Anchors
// are valid YAML but reduce diff readability and are unnecessary here.
const YAML_OPTS = { lineWidth: 0, aliasDuplicateObjects: false } as const;
const DOC_SEPARATOR = '---\n';
const SERVICE_MONITOR_LABEL = 'prometheus';
const SERVICE_MONITOR_LABEL_VALUE = 'kube-prometheus';

/** Public entry — reads each agent.yaml off disk, returns rendered files. */
export async function renderK8s(
  fleet: LoadedFleet,
  opts: RenderOptions = {},
): Promise<RenderedFile[]> {
  const resolved = resolveRenderOptions(fleet.manifest.name, opts);
  const agentSources = await Promise.all(
    fleet.agents.map(async (a) => ({
      agent: a,
      agentYaml: await readFile(a.agentYamlPath, 'utf-8'),
    })),
  );
  return renderK8sFromSources(fleet, agentSources, resolved);
}

export interface AgentSource {
  readonly agent: LoadedAgentEntry;
  readonly agentYaml: string;
}

/** Pure renderer for tests — caller provides pre-read agent.yaml text. */
export function renderK8sFromSources(
  fleet: LoadedFleet,
  agents: readonly AgentSource[],
  resolvedInput: ResolvedRenderOptions | RenderOptions = {},
): RenderedFile[] {
  const resolved = isResolved(resolvedInput)
    ? resolvedInput
    : resolveRenderOptions(fleet.manifest.name, resolvedInput);

  const fleetName = sanitizeDns1123Label(fleet.manifest.name);
  const files: RenderedFile[] = [];

  // 1. Namespace — one per fleet. Stable `name` + labels.
  files.push({
    path: '00-namespace.yaml',
    contents: stringifyYaml(
      {
        apiVersion: 'v1',
        kind: 'Namespace',
        metadata: {
          name: resolved.namespace,
          labels: {
            'app.kubernetes.io/part-of': fleetName,
            'app.kubernetes.io/managed-by': 'declaragent',
          },
        },
      },
      YAML_OPTS,
    ),
  });

  // 2. Collect every `${secret:<ref>}` across every agent.yaml, union
  //    and stable-sort it, then emit a single combined Secret stub.
  //    Secret values are NEVER embedded — we emit only the keys with
  //    empty `stringData` so `kubectl apply` accepts the manifest but
  //    the operator must supply actual values via `kubectl edit` or an
  //    out-of-band sealed-secret / external-secrets flow.
  const secretRefs = unionSecretRefs(agents);
  if (secretRefs.length > 0) {
    files.push({
      path: '10-secrets.yaml',
      contents: stringifyYaml(
        {
          apiVersion: 'v1',
          kind: 'Secret',
          metadata: {
            name: `${fleetName}-secrets`,
            namespace: resolved.namespace,
            labels: {
              'app.kubernetes.io/part-of': fleetName,
              'app.kubernetes.io/managed-by': 'declaragent',
            },
            annotations: {
              'declaragent.io/note':
                'Keys only — operator must populate values out-of-band (Sealed Secrets, External Secrets, or `kubectl edit`). fleet render NEVER emits secret values.',
            },
          },
          type: 'Opaque',
          stringData: Object.fromEntries(secretRefs.map((ref) => [secretRefToEnvName(ref), ''])),
        },
        YAML_OPTS,
      ),
    });
  }

  // 3. Per-agent resources. Agents iterate in manifest order (already
  //    stable because `loadFleet` preserves array order), and each
  //    agent's resources sort as ConfigMap → Deployment → Service
  //    within its own file. ServiceMonitor is emitted into a SEPARATE
  //    `agents/<id>-servicemonitor.yaml` file so operators running
  //    vanilla Prometheus (no Operator CRD) can `rm` it without
  //    touching the core workload manifests. (#31)
  for (const src of agents) {
    const docs: string[] = [];
    docs.push(renderConfigMap(src, fleetName, resolved));
    docs.push(renderDeployment(src, fleetName, resolved, secretRefs));
    docs.push(renderService(src, fleetName, resolved));
    const safeId = sanitizeDns1123Label(src.agent.id);
    const agentFile = `agents/${safeId}.yaml`;
    files.push({
      path: agentFile,
      contents: docs.join(DOC_SEPARATOR),
    });
    if (resolved.serviceMonitor) {
      files.push({
        path: `agents/${safeId}-servicemonitor.yaml`,
        contents: renderServiceMonitor(src, fleetName, resolved),
      });
    }
  }

  // Deterministic file order — every caller can `diff` across renders.
  files.sort((a, b) => a.path.localeCompare(b.path));
  return files;
}

// ── Per-resource renderers ─────────────────────────────────────────────

function renderConfigMap(
  src: AgentSource,
  fleetName: string,
  resolved: ResolvedRenderOptions,
): string {
  const name = configMapName(src.agent.id);
  return stringifyYaml(
    {
      apiVersion: 'v1',
      kind: 'ConfigMap',
      metadata: {
        name,
        namespace: resolved.namespace,
        labels: labelsFor(src.agent.id, fleetName),
      },
      data: {
        'agent.yaml': src.agentYaml,
      },
    },
    YAML_OPTS,
  );
}

function renderDeployment(
  src: AgentSource,
  fleetName: string,
  resolved: ResolvedRenderOptions,
  fleetSecretRefs: readonly string[],
): string {
  const name = sanitizeDns1123Label(src.agent.id);
  const labels = labelsFor(src.agent.id, fleetName);
  const replicas = pickReplicas(src.agent, resolved);

  // Env: always inject `DECLARAGENT_FLEET_VERSION` (runtime uses it for
  // outbound RPC headers). Every agent-local secret ref becomes an
  // envFrom into the single fleet-wide Secret (no values, just refs).
  const env: Array<Record<string, unknown>> = [
    { name: 'DECLARAGENT_AGENT_ID', value: src.agent.id },
    { name: 'DECLARAGENT_FLEET_NAME', value: fleetName },
  ];

  const container: Record<string, unknown> = {
    name: 'declaragent',
    image: resolved.image,
    imagePullPolicy: 'IfNotPresent',
    args: ['up', '-d', '-f', '/etc/declaragent/agent.yaml'],
    ports: [{ name: 'metrics', containerPort: resolved.metricsPort, protocol: 'TCP' }],
    env,
    volumeMounts: [{ name: 'agent-config', mountPath: '/etc/declaragent', readOnly: true }],
    readinessProbe: {
      httpGet: { path: resolved.healthProbePath, port: 'metrics' },
      initialDelaySeconds: 3,
      periodSeconds: 10,
    },
    livenessProbe: {
      httpGet: { path: resolved.healthProbePath, port: 'metrics' },
      initialDelaySeconds: 15,
      periodSeconds: 30,
    },
    resources: {
      requests: { cpu: '100m', memory: '128Mi' },
      limits: { cpu: '500m', memory: '512Mi' },
    },
  };

  // Only emit envFrom when there is at least one secret, so manifests
  // stay minimal for fleets that don't reference `${secret:...}`.
  if (fleetSecretRefs.length > 0) {
    container.envFrom = [{ secretRef: { name: `${fleetName}-secrets` } }];
  }

  return stringifyYaml(
    {
      apiVersion: 'apps/v1',
      kind: 'Deployment',
      metadata: {
        name,
        namespace: resolved.namespace,
        labels,
      },
      spec: {
        replicas,
        selector: { matchLabels: selectorLabelsFor(src.agent.id, fleetName) },
        template: {
          metadata: { labels },
          spec: {
            containers: [container],
            volumes: [
              {
                name: 'agent-config',
                configMap: { name: configMapName(src.agent.id) },
              },
            ],
          },
        },
      },
    },
    YAML_OPTS,
  );
}

function renderService(
  src: AgentSource,
  fleetName: string,
  resolved: ResolvedRenderOptions,
): string {
  const name = sanitizeDns1123Label(src.agent.id);
  return stringifyYaml(
    {
      apiVersion: 'v1',
      kind: 'Service',
      metadata: {
        name,
        namespace: resolved.namespace,
        labels: labelsFor(src.agent.id, fleetName),
      },
      spec: {
        type: 'ClusterIP',
        selector: selectorLabelsFor(src.agent.id, fleetName),
        ports: [
          {
            name: 'metrics',
            port: resolved.metricsPort,
            targetPort: 'metrics',
            protocol: 'TCP',
          },
        ],
      },
    },
    YAML_OPTS,
  );
}

function renderServiceMonitor(
  src: AgentSource,
  fleetName: string,
  resolved: ResolvedRenderOptions,
): string {
  const name = sanitizeDns1123Label(src.agent.id);
  return stringifyYaml(
    {
      apiVersion: 'monitoring.coreos.com/v1',
      kind: 'ServiceMonitor',
      metadata: {
        name,
        namespace: resolved.namespace,
        labels: {
          ...labelsFor(src.agent.id, fleetName),
          [SERVICE_MONITOR_LABEL]: SERVICE_MONITOR_LABEL_VALUE,
        },
      },
      spec: {
        selector: { matchLabels: selectorLabelsFor(src.agent.id, fleetName) },
        endpoints: [
          {
            port: 'metrics',
            path: '/metrics',
            interval: '30s',
          },
        ],
      },
    },
    YAML_OPTS,
  );
}

// ── Helpers ────────────────────────────────────────────────────────────

function configMapName(agentId: string): string {
  return `${sanitizeDns1123Label(agentId)}-config`;
}

function labelsFor(agentId: string, fleetName: string): Record<string, string> {
  // Object-literal order is the YAML emission order — keep `name`
  // first so diffs are readable.
  return {
    'app.kubernetes.io/name': sanitizeDns1123Label(agentId),
    'app.kubernetes.io/part-of': fleetName,
    'app.kubernetes.io/managed-by': 'declaragent',
    'declaragent.io/agent-id': sanitizeDns1123Label(agentId),
  };
}

function selectorLabelsFor(agentId: string, fleetName: string): Record<string, string> {
  // Selectors must stay narrow — if you add to `labelsFor`, DO NOT add
  // here, or existing Deployments stop selecting their own pods.
  return {
    'app.kubernetes.io/name': sanitizeDns1123Label(agentId),
    'app.kubernetes.io/part-of': fleetName,
  };
}

function pickReplicas(agent: LoadedAgentEntry, resolved: ResolvedRenderOptions): number {
  const perAgentMin = agent.entry.deploy?.minInstances;
  if (typeof perAgentMin === 'number' && perAgentMin > 0) return perAgentMin;
  return resolved.replicas;
}

function unionSecretRefs(agents: readonly AgentSource[]): string[] {
  const seen = new Set<string>();
  for (const src of agents) {
    let parsed: unknown;
    try {
      parsed = parseYaml(src.agentYaml);
    } catch {
      continue; // Skip unparseable agent.yaml; rendering a stub is OK.
    }
    for (const ref of extractSecretRefs(parsed)) seen.add(ref);
  }
  return [...seen].sort();
}

function isResolved(v: ResolvedRenderOptions | RenderOptions): v is ResolvedRenderOptions {
  return (
    typeof (v as ResolvedRenderOptions).image === 'string' &&
    typeof (v as ResolvedRenderOptions).replicas === 'number' &&
    typeof (v as ResolvedRenderOptions).namespace === 'string' &&
    typeof (v as ResolvedRenderOptions).serviceMonitor === 'boolean' &&
    typeof (v as ResolvedRenderOptions).metricsPort === 'number' &&
    typeof (v as ResolvedRenderOptions).healthProbePath === 'string'
  );
}
