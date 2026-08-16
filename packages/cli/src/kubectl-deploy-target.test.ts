import { describe, expect, test } from 'bun:test';
import type { LoadedAgentEntry, LoadedFleet } from '@declaragent/core';
import type { DeployContext } from './fleet-deploy-cli.js';
import { type KubectlExecResult, createKubectlDeployTarget } from './kubectl-deploy-target.js';

function fakeFleet(): LoadedFleet {
  return {
    manifest: { name: 'sev-desk' },
    root: '/fleet',
  } as unknown as LoadedFleet;
}

function agent(id: string): LoadedAgentEntry {
  return { id } as unknown as LoadedAgentEntry;
}

function contextFor(targetConfig: Record<string, unknown>): DeployContext {
  return {
    fleet: fakeFleet(),
    fleetVersion: '2026.08.17',
    targetConfig: { kind: 'kubectl', ...targetConfig } as DeployContext['targetConfig'],
    logger: { out: () => {}, err: () => {} },
    injectedEnv: { DECLARAGENT_FLEET_VERSION: '2026.08.17' },
  };
}

interface RecordedExec {
  calls: string[][];
  exec: (argv: readonly string[]) => Promise<KubectlExecResult>;
}

function recorder(
  respond: (argv: readonly string[]) => Partial<KubectlExecResult> | undefined = () => undefined,
): RecordedExec {
  const calls: string[][] = [];
  return {
    calls,
    exec: async (argv) => {
      calls.push([...argv]);
      const over = respond(argv) ?? {};
      return { code: 0, stdout: '', stderr: '', ...over };
    },
  };
}

describe('createKubectlDeployTarget', () => {
  test('deploy: namespace apply → agent apply → set env → rollout status → artifact with image', async () => {
    const r = recorder((argv) =>
      argv.includes('jsonpath={.spec.template.spec.containers[0].image}')
        ? { stdout: 'declaragent/agent:dev\n' }
        : undefined,
    );
    const target = createKubectlDeployTarget({ exec: r.exec, fileExists: () => true });
    const outcome = await target.deploy(agent('triage'), contextFor({ renderDir: './render' }));

    expect(outcome).toEqual({
      ok: true,
      artifact: 'sev-desk/deployment/triage @ declaragent/agent:dev',
    });
    expect(r.calls[0]).toEqual(['kubectl', 'apply', '-f', '/fleet/render/00-namespace.yaml']);
    expect(r.calls[1]).toEqual(['kubectl', 'apply', '-f', '/fleet/render/agents/triage.yaml']);
    expect(r.calls[2]).toEqual([
      'kubectl',
      '-n',
      'sev-desk',
      'set',
      'env',
      'deployment/triage',
      'DECLARAGENT_FLEET_VERSION=2026.08.17',
    ]);
    expect(r.calls[3]).toEqual([
      'kubectl',
      '-n',
      'sev-desk',
      'rollout',
      'status',
      'deployment/triage',
      '--timeout=180s',
    ]);
  });

  test('deploy honours namespace, context, rolloutTimeoutSec overrides + skips missing ns manifest', async () => {
    const r = recorder();
    const target = createKubectlDeployTarget({
      exec: r.exec,
      fileExists: (p) => !p.endsWith('00-namespace.yaml'),
    });
    const outcome = await target.deploy(
      agent('triage'),
      contextFor({ namespace: 'custom-ns', context: 'minikube', rolloutTimeoutSec: 30 }),
    );
    expect(outcome.ok).toBe(true);
    expect(r.calls[0]).toEqual([
      'kubectl',
      '--context',
      'minikube',
      'apply',
      '-f',
      '/fleet/render/agents/triage.yaml',
    ]);
    const rollout = r.calls.find((c) => c.includes('status'));
    expect(rollout).toContain('custom-ns');
    expect(rollout).toContain('--timeout=30s');
  });

  test('deploy fails actionably when the rendered manifest is missing', async () => {
    const r = recorder();
    const target = createKubectlDeployTarget({ exec: r.exec, fileExists: () => false });
    const outcome = await target.deploy(agent('triage'), contextFor({}));
    expect(outcome.ok).toBe(false);
    if (outcome.ok) throw new Error('unreachable');
    expect(outcome.error).toContain('fleet render --target k8s');
    expect(r.calls).toEqual([]);
  });

  test('deploy surfaces a failed rollout with stderr detail', async () => {
    const r = recorder((argv) =>
      argv.includes('status')
        ? { code: 1, stderr: 'deployment "triage" exceeded its progress deadline' }
        : undefined,
    );
    const target = createKubectlDeployTarget({ exec: r.exec, fileExists: () => true });
    const outcome = await target.deploy(agent('triage'), contextFor({}));
    expect(outcome.ok).toBe(false);
    if (outcome.ok) throw new Error('unreachable');
    expect(outcome.error).toContain('progress deadline');
  });

  test('healthCheck: availableReplicas >= 1 passes, 0/empty fails', async () => {
    let replicas = '1';
    const r = recorder(() => ({ stdout: replicas }));
    const target = createKubectlDeployTarget({ exec: r.exec, fileExists: () => true });
    expect((await target.healthCheck?.(agent('triage'), contextFor({})))?.ok).toBe(true);
    replicas = '';
    const down = await target.healthCheck?.(agent('triage'), contextFor({}));
    expect(down?.ok).toBe(false);
    expect(down?.message).toContain('0 available replicas');
  });

  test('rollback runs rollout undo (throws on failure)', async () => {
    const good = recorder();
    const target = createKubectlDeployTarget({ exec: good.exec, fileExists: () => true });
    await target.rollback?.(agent('triage'), {} as never, contextFor({}));
    expect(good.calls[0]).toEqual([
      'kubectl',
      '-n',
      'sev-desk',
      'rollout',
      'undo',
      'deployment/triage',
    ]);

    const bad = recorder((argv) =>
      argv.includes('undo') ? { code: 1, stderr: 'boom' } : undefined,
    );
    const failing = createKubectlDeployTarget({ exec: bad.exec, fileExists: () => true });
    await expect(failing.rollback?.(agent('triage'), {} as never, contextFor({}))).rejects.toThrow(
      'boom',
    );
  });
});
