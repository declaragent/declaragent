/**
 * Render a {@link LoadedFleet} to a Kustomize base + per-env overlays.
 *
 * Emitted layout:
 *
 * ```
 * <out>/
 * ├── kustomization.yaml           # root — refs ./base
 * ├── base/
 * │   ├── kustomization.yaml       # lists every resource under base/
 * │   ├── 00-namespace.yaml
 * │   ├── 10-secrets.yaml          # optional (same rule as k8s renderer)
 * │   └── agents/
 * │       ├── <id>.yaml            # ConfigMap[s] + Deployment + Service
 * │       └── <id>-servicemonitor.yaml   # optional
 * └── overlays/
 *     ├── dev/kustomization.yaml
 *     ├── staging/kustomization.yaml
 *     └── prod/kustomization.yaml
 * ```
 *
 * The base reuses the pure `renderK8sFromSources` output — a Kustomize
 * overlay and `kubectl apply -k` both accept vanilla YAML, so we get
 * one rendering pipeline, two packaging wrappers (Helm + Kustomize).
 *
 * Overlay defaults — deliberate, documented presets (operators are
 * expected to tune before deploying to prod):
 *   - `dev`     → replicas=1, memory limit 512Mi (dev boxes / CI).
 *   - `staging` → replicas=2, memory limit 1Gi (pre-prod smoke).
 *   - `prod`    → replicas=3, memory limit 2Gi (HA + headroom).
 *
 * @since 0.7.5 (post-enterprise backlog #33)
 */

import { readFile } from 'node:fs/promises';
import type { LoadedFleet } from '@declaragent/core';
import { stringify as stringifyYaml } from 'yaml';
import { type AgentSource, renderK8sFromSources } from './k8s-renderer.js';
import {
  type RenderOptions,
  type RenderedFile,
  type ResolvedRenderOptions,
  resolveRenderOptions,
  sanitizeDns1123Label,
} from './types.js';

const YAML_OPTS = { lineWidth: 0, aliasDuplicateObjects: false } as const;

/** Public entry — reads each agent.yaml off disk, returns rendered files. */
export async function renderKustomize(
  fleet: LoadedFleet,
  opts: RenderOptions = {},
): Promise<RenderedFile[]> {
  const agentSources = await Promise.all(
    fleet.agents.map(async (a) => ({
      agent: a,
      agentYaml: await readFile(a.agentYamlPath, 'utf-8'),
    })),
  );
  return renderKustomizeFromSources(fleet, agentSources, opts);
}

/** Pure renderer for tests — caller provides pre-read agent.yaml text. */
export function renderKustomizeFromSources(
  fleet: LoadedFleet,
  agents: readonly AgentSource[],
  opts: RenderOptions = {},
): RenderedFile[] {
  const resolved = resolveRenderOptions(fleet.manifest.name, opts);
  const files: RenderedFile[] = [];

  // 1. Base — reuse the k8s renderer, prefix every file with `base/`.
  const baseFiles = renderK8sFromSources(fleet, agents, resolved);
  for (const f of baseFiles) {
    files.push({ path: `base/${f.path}`, contents: f.contents });
  }

  // 2. base/kustomization.yaml — enumerate resource files.
  files.push({
    path: 'base/kustomization.yaml',
    contents: renderBaseKustomization(baseFiles, resolved),
  });

  // 3. Per-env overlays. Deliberate, documented defaults — operators
  //    tune by editing the overlay in their GitOps repo.
  for (const env of OVERLAY_ENVS) {
    files.push({
      path: `overlays/${env.name}/kustomization.yaml`,
      contents: renderOverlayKustomization(env, fleet, agents, resolved),
    });
  }

  // 4. Root kustomization.yaml — points at base by default so a plain
  //    `kubectl apply -k <out>` deploys the un-overlayed baseline.
  files.push({
    path: 'kustomization.yaml',
    contents: renderRootKustomization(resolved),
  });

  files.sort((a, b) => a.path.localeCompare(b.path));
  return files;
}

// ── Base kustomization ─────────────────────────────────────────────────

function renderBaseKustomization(
  baseFiles: readonly RenderedFile[],
  resolved: ResolvedRenderOptions,
): string {
  const resources = baseFiles.map((f) => f.path).sort();
  return stringifyYaml(
    {
      apiVersion: 'kustomize.config.k8s.io/v1beta1',
      kind: 'Kustomization',
      namespace: resolved.namespace,
      commonLabels: {
        'app.kubernetes.io/managed-by': 'declaragent',
      },
      resources,
    },
    YAML_OPTS,
  );
}

// ── Root kustomization ─────────────────────────────────────────────────

function renderRootKustomization(resolved: ResolvedRenderOptions): string {
  return stringifyYaml(
    {
      apiVersion: 'kustomize.config.k8s.io/v1beta1',
      kind: 'Kustomization',
      // Root points at base so `kubectl apply -k <dir>` Just Works.
      // Operators wanting an environment overlay apply that overlay
      // directory instead (`kubectl apply -k overlays/prod`).
      resources: ['./base'],
      // Surface the resolved namespace here too so the root target is
      // self-describing — kustomize walks ./base/kustomization.yaml
      // regardless, so this is belt-and-braces.
      namespace: resolved.namespace,
    },
    YAML_OPTS,
  );
}

// ── Per-env overlays ───────────────────────────────────────────────────

interface OverlayEnv {
  readonly name: 'dev' | 'staging' | 'prod';
  readonly replicas: number;
  readonly memoryLimit: string;
  readonly cpuLimit: string;
}

const OVERLAY_ENVS: readonly OverlayEnv[] = [
  { name: 'dev', replicas: 1, memoryLimit: '512Mi', cpuLimit: '500m' },
  { name: 'staging', replicas: 2, memoryLimit: '1Gi', cpuLimit: '1000m' },
  { name: 'prod', replicas: 3, memoryLimit: '2Gi', cpuLimit: '2000m' },
];

function renderOverlayKustomization(
  env: OverlayEnv,
  fleet: LoadedFleet,
  agents: readonly AgentSource[],
  resolved: ResolvedRenderOptions,
): string {
  const nsSuffix = env.name === 'prod' ? '' : `-${env.name}`;
  const overlayNamespace = `${resolved.namespace}${nsSuffix}`;

  // One Deployment patch per agent — strategic merge on name. We keep
  // the patch list deterministic by sorting on agent id.
  const deploymentPatches = [...agents]
    .map((a) => sanitizeDns1123Label(a.agent.id))
    .sort()
    .map((safeId) => ({
      target: {
        kind: 'Deployment',
        name: safeId,
      },
      patch: stringifyDeploymentPatch(safeId, env),
    }));

  return stringifyYaml(
    {
      apiVersion: 'kustomize.config.k8s.io/v1beta1',
      kind: 'Kustomization',
      namespace: overlayNamespace,
      resources: ['../../base'],
      commonLabels: {
        'declaragent.io/environment': env.name,
      },
      patches: deploymentPatches,
      // Namespace-level annotation so operators can `kubectl get ns`
      // and see the environment tier at a glance.
      commonAnnotations: {
        'declaragent.io/fleet': sanitizeDns1123Label(fleet.manifest.name),
        'declaragent.io/environment': env.name,
      },
    },
    YAML_OPTS,
  );
}

/**
 * Strategic-merge patch for a single agent's Deployment. Inlined as a
 * YAML string (kustomize's `patches[].patch` accepts either a path or
 * inline YAML) so the overlay is self-contained — no separate patch
 * files needed.
 */
function stringifyDeploymentPatch(safeId: string, env: OverlayEnv): string {
  const patch = {
    apiVersion: 'apps/v1',
    kind: 'Deployment',
    metadata: {
      name: safeId,
    },
    spec: {
      replicas: env.replicas,
      template: {
        spec: {
          containers: [
            {
              name: 'declaragent',
              resources: {
                limits: {
                  cpu: env.cpuLimit,
                  memory: env.memoryLimit,
                },
              },
            },
          ],
        },
      },
    },
  };
  return stringifyYaml(patch, YAML_OPTS);
}
