/**
 * `createKubectlDeployTarget` — the first real `FleetDeployTarget` adapter
 * (WS6, PRODUCTION_READINESS_PLAN.md: "one `createKubectlDeployTarget`
 * adapter runs apply + rollout-status + rollout-undo").
 *
 * Deploys the manifests `declaragent fleet render --target k8s` produced:
 * per agent, `kubectl apply` the agent's manifest file, stamp the injected
 * fleet-version env (§8.2), then block on `kubectl rollout status`. Health
 * checks read `availableReplicas`; rollback is `kubectl rollout undo`.
 *
 * `fleet.yaml` wiring (extra keys pass through `deploy.targets{}`):
 *
 *     deploy:
 *       strategy: rolling
 *       rollbackOnFailure: true
 *       targets:
 *         k8s:
 *           kind: kubectl
 *           renderDir: ./render        # fleet render --out (default ./render)
 *           namespace: my-fleet        # default: fleet manifest name
 *           context: minikube          # optional kubeconfig context
 *           rolloutTimeoutSec: 180     # default 180
 *
 * Then: `declaragent fleet deploy --target k8s` (index.tsx registers this
 * adapter for `kind: kubectl` by default).
 *
 * The kubectl shell-out is injectable (`exec`) so tests are hermetic.
 *
 * @since 0.7.8 — production-readiness WS6 tail
 */

import { existsSync } from 'node:fs';
import { isAbsolute, join } from 'node:path';
import type { DeployContext, FleetDeployTarget } from './fleet-deploy-cli.js';

export interface KubectlExecResult {
  readonly code: number;
  readonly stdout: string;
  readonly stderr: string;
}

export type KubectlExec = (argv: readonly string[]) => Promise<KubectlExecResult>;

const defaultExec: KubectlExec = async (argv) => {
  const proc = Bun.spawn([...argv], { stdout: 'pipe', stderr: 'pipe' });
  const [stdout, stderr, code] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  return { code, stdout, stderr };
};

export interface CreateKubectlDeployTargetOptions {
  /** Injected exec for tests. Defaults to spawning the real binary. */
  exec?: KubectlExec;
  /** kubectl binary. Default `kubectl`. */
  kubectlBin?: string;
  /** File-existence probe, injectable for tests. */
  fileExists?: (path: string) => boolean;
}

interface KubectlTargetSettings {
  renderDir: string;
  namespace: string;
  contextArgs: readonly string[];
  rolloutTimeoutSec: number;
}

function trimOneLine(s: string): string {
  return s.trim().split('\n')[0] ?? '';
}

export function createKubectlDeployTarget(
  options: CreateKubectlDeployTargetOptions = {},
): FleetDeployTarget {
  const exec = options.exec ?? defaultExec;
  const kubectl = options.kubectlBin ?? 'kubectl';
  const fileExists = options.fileExists ?? existsSync;
  /** Namespace manifests already applied this process (idempotent anyway). */
  const namespacesApplied = new Set<string>();

  function settingsFrom(context: DeployContext): KubectlTargetSettings {
    const cfg = context.targetConfig as Record<string, unknown>;
    const rawDir = typeof cfg.renderDir === 'string' ? cfg.renderDir : './render';
    const renderDir = isAbsolute(rawDir) ? rawDir : join(context.fleet.root, rawDir);
    const namespace =
      typeof cfg.namespace === 'string' && cfg.namespace.length > 0
        ? cfg.namespace
        : context.fleet.manifest.name;
    const contextArgs =
      typeof cfg.context === 'string' && cfg.context.length > 0 ? ['--context', cfg.context] : [];
    const rolloutTimeoutSec =
      typeof cfg.rolloutTimeoutSec === 'number' && Number.isFinite(cfg.rolloutTimeoutSec)
        ? cfg.rolloutTimeoutSec
        : 180;
    return { renderDir, namespace, contextArgs, rolloutTimeoutSec };
  }

  async function run(
    argv: readonly string[],
    label: string,
  ): Promise<{ ok: true; result: KubectlExecResult } | { ok: false; error: string }> {
    const result = await exec(argv);
    if (result.code !== 0) {
      return {
        ok: false,
        error: `${label} failed (exit ${result.code}): ${trimOneLine(result.stderr) || trimOneLine(result.stdout)}`,
      };
    }
    return { ok: true, result };
  }

  return {
    kind: 'kubectl',

    async deploy(agent, context) {
      const s = settingsFrom(context);
      const manifest = join(s.renderDir, 'agents', `${agent.id}.yaml`);
      if (!fileExists(manifest)) {
        return {
          ok: false,
          error: `rendered manifest not found: ${manifest}. Run \`declaragent fleet render --target k8s --out ${s.renderDir}\` first.`,
        };
      }

      // Namespace first (idempotent apply; cached per process for tidiness).
      const nsManifest = join(s.renderDir, '00-namespace.yaml');
      if (!namespacesApplied.has(nsManifest) && fileExists(nsManifest)) {
        const ns = await run(
          [kubectl, ...s.contextArgs, 'apply', '-f', nsManifest],
          'namespace apply',
        );
        if (!ns.ok) return { ok: false, error: ns.error };
        namespacesApplied.add(nsManifest);
      }

      const apply = await run(
        [kubectl, ...s.contextArgs, 'apply', '-f', manifest],
        `kubectl apply (${agent.id})`,
      );
      if (!apply.ok) return { ok: false, error: apply.error };

      // §8.2 — stamp the injected env (DECLARAGENT_FLEET_VERSION + any
      // target-specific additions) onto the runtime.
      const envPairs = Object.entries(context.injectedEnv).map(([k, v]) => `${k}=${v}`);
      if (envPairs.length > 0) {
        const setEnv = await run(
          [
            kubectl,
            ...s.contextArgs,
            '-n',
            s.namespace,
            'set',
            'env',
            `deployment/${agent.id}`,
            ...envPairs,
          ],
          `kubectl set env (${agent.id})`,
        );
        if (!setEnv.ok) return { ok: false, error: setEnv.error };
      }

      const rollout = await run(
        [
          kubectl,
          ...s.contextArgs,
          '-n',
          s.namespace,
          'rollout',
          'status',
          `deployment/${agent.id}`,
          `--timeout=${s.rolloutTimeoutSec}s`,
        ],
        `kubectl rollout status (${agent.id})`,
      );
      if (!rollout.ok) return { ok: false, error: rollout.error };

      const image = await run(
        [
          kubectl,
          ...s.contextArgs,
          '-n',
          s.namespace,
          'get',
          `deployment/${agent.id}`,
          '-o',
          'jsonpath={.spec.template.spec.containers[0].image}',
        ],
        `kubectl get image (${agent.id})`,
      );
      const artifact = image.ok
        ? `${s.namespace}/deployment/${agent.id} @ ${trimOneLine(image.result.stdout)}`
        : `${s.namespace}/deployment/${agent.id}`;
      return { ok: true, artifact };
    },

    async healthCheck(agent, context) {
      const s = settingsFrom(context);
      const probe = await run(
        [
          kubectl,
          ...s.contextArgs,
          '-n',
          s.namespace,
          'get',
          `deployment/${agent.id}`,
          '-o',
          'jsonpath={.status.availableReplicas}',
        ],
        `kubectl get availableReplicas (${agent.id})`,
      );
      if (!probe.ok) return { ok: false, message: probe.error };
      const available = Number.parseInt(trimOneLine(probe.result.stdout) || '0', 10);
      if (!Number.isFinite(available) || available < 1) {
        return { ok: false, message: `deployment/${agent.id}: 0 available replicas` };
      }
      return { ok: true };
    },

    async rollback(agent, _previous, context) {
      const s = settingsFrom(context);
      const undo = await run(
        [kubectl, ...s.contextArgs, '-n', s.namespace, 'rollout', 'undo', `deployment/${agent.id}`],
        `kubectl rollout undo (${agent.id})`,
      );
      if (!undo.ok) throw new Error(undo.error);
      // Best-effort: wait for the rolled-back generation to settle so the
      // executor's post-rollback state is observable, but a slow settle
      // should not mask the original failure.
      await run(
        [
          kubectl,
          ...s.contextArgs,
          '-n',
          s.namespace,
          'rollout',
          'status',
          `deployment/${agent.id}`,
          `--timeout=${s.rolloutTimeoutSec}s`,
        ],
        `kubectl rollout status post-undo (${agent.id})`,
      );
    },
  };
}
