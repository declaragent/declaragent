import { describe, expect, test } from 'bun:test';
import { collectToolEvents, makeToolContext } from '../testing/context.js';
import { Bash } from './bash.js';

describe('Bash tool', () => {
  test('runs a simple command and captures stdout', async () => {
    const out = await collectToolEvents(Bash.execute({ command: 'echo hello' }, makeToolContext()));
    expect(out.error).toBeUndefined();
    expect(out.result?.exitCode).toBe(0);
    expect(out.result?.stdout.trim()).toBe('hello');
    expect(out.result?.timedOut).toBe(false);
  });

  test('captures stderr and non-zero exit', async () => {
    const out = await collectToolEvents(
      Bash.execute({ command: 'echo oops 1>&2 && exit 7' }, makeToolContext()),
    );
    expect(out.result?.exitCode).toBe(7);
    expect(out.result?.stderr.trim()).toBe('oops');
  });

  test('respects cwd', async () => {
    const out = await collectToolEvents(
      Bash.execute({ command: 'pwd', cwd: '/tmp' }, makeToolContext()),
    );
    // macOS resolves /tmp → /private/tmp; just check it ends in /tmp.
    expect(out.result?.stdout.trim().endsWith('/tmp')).toBe(true);
  });

  // Default bun-test timeout is 5s. On loaded CI runners the SIGKILL +
  // process-exit propagation round-trip occasionally grazes that limit,
  // even though the tool's own `timeoutMs: 50` fires fast. Give the
  // harness 15s to avoid flaky failures — the real assertion is still
  // that `timedOut` was set, not that the whole thing finished in <5s.
  const TIMEOUT_TEST_HARNESS_BUDGET_MS = 15_000;
  test(
    'timeout fires and reports timedOut',
    async () => {
      const out = await collectToolEvents(
        Bash.execute({ command: 'sleep 5', timeoutMs: 50 }, makeToolContext()),
      );
      // Either the process was killed (exit != 0) or an error was reported.
      const timed = out.result?.timedOut === true || out.error?.code === 'ETIMEDOUT';
      expect(timed).toBe(true);
    },
    TIMEOUT_TEST_HARNESS_BUDGET_MS,
  );

  test('permission key is the command string', () => {
    expect(Bash.permissionKey({ command: 'git status' })).toBe('git status');
  });

  test('is not readonly', () => {
    expect(Bash.readonly).toBeUndefined();
  });

  // Regression: a prompt-injected command must not be able to read the
  // daemon's secret environment. THREAT_MODEL.md depends on this.
  test('does not leak secret env vars to the subprocess', async () => {
    const SECRETS = ['ANTHROPIC_API_KEY', 'OPENROUTER_API_KEY', 'AWS_SECRET_ACCESS_KEY'];
    const prior = SECRETS.map((k) => [k, process.env[k]] as const);
    for (const k of SECRETS) process.env[k] = `leak-${k}`;
    try {
      const out = await collectToolEvents(Bash.execute({ command: 'env' }, makeToolContext()));
      const printed = out.result?.stdout ?? '';
      for (const k of SECRETS) {
        expect(printed).not.toContain(`leak-${k}`);
        expect(printed).not.toContain(`${k}=`);
      }
      // Safe vars still reach the subprocess.
      expect(printed).toContain('PATH=');
    } finally {
      for (const [k, v] of prior) {
        if (v === undefined) delete process.env[k];
        else process.env[k] = v;
      }
    }
  });

  test('allowlist env var lets an operator pass a specific key through', async () => {
    const KEYS = ['MY_SCRIPT_VAR', 'ANOTHER_VAR', 'DECLARAGENT_BASH_ENV_ALLOW'];
    const prior = KEYS.map((k) => [k, process.env[k]] as const);
    process.env.MY_SCRIPT_VAR = 'visible-value';
    process.env.ANOTHER_VAR = 'hidden-value';
    process.env.DECLARAGENT_BASH_ENV_ALLOW = 'MY_SCRIPT_VAR';
    try {
      const out = await collectToolEvents(Bash.execute({ command: 'env' }, makeToolContext()));
      const printed = out.result?.stdout ?? '';
      expect(printed).toContain('MY_SCRIPT_VAR=visible-value');
      expect(printed).not.toContain('ANOTHER_VAR=hidden-value');
      expect(printed).toContain('PATH=');
    } finally {
      for (const [k, v] of prior) {
        if (v === undefined) delete process.env[k];
        else process.env[k] = v;
      }
    }
  });
});
