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

  test('timeout fires and reports timedOut', async () => {
    const out = await collectToolEvents(
      Bash.execute({ command: 'sleep 5', timeoutMs: 50 }, makeToolContext()),
    );
    // Either the process was killed (exit != 0) or an error was reported.
    const timed = out.result?.timedOut === true || out.error?.code === 'ETIMEDOUT';
    expect(timed).toBe(true);
  });

  test('permission key is the command string', () => {
    expect(Bash.permissionKey({ command: 'git status' })).toBe('git status');
  });

  test('is not readonly', () => {
    expect(Bash.readonly).toBeUndefined();
  });
});
