import { describe, expect, test } from 'bun:test';
import { RpcAbandonedError, RpcBusyError, RpcTimeoutError } from '@declaragent/core';
import { createPendingRegistry } from './pending-registry.js';

describe('createPendingRegistry', () => {
  test('settles a pending correlation', async () => {
    const reg = createPendingRegistry();
    const p = reg.register({ correlationId: 'c1', deadlineMs: Date.now() + 1000 });
    expect(reg.size()).toBe(1);
    expect(reg.settle('c1', { status: 'ok', data: { value: 42 } })).toBe(true);
    const result = await p;
    expect(result).toEqual({ status: 'ok', data: { value: 42 } });
    expect(reg.size()).toBe(0);
  });

  test('rejects with RpcTimeoutError when deadline passes', async () => {
    const reg = createPendingRegistry();
    const p = reg.register({ correlationId: 'c1', deadlineMs: Date.now() + 10 });
    await expect(p).rejects.toBeInstanceOf(RpcTimeoutError);
  });

  test('settle returns false for unknown correlationId (stale response)', () => {
    const reg = createPendingRegistry();
    expect(reg.settle('unknown', { status: 'ok', data: null })).toBe(false);
  });

  test('abandon rejects every live entry with RpcAbandonedError', async () => {
    const reg = createPendingRegistry();
    const p1 = reg.register({ correlationId: 'c1', deadlineMs: Date.now() + 10_000 });
    const p2 = reg.register({ correlationId: 'c2', deadlineMs: Date.now() + 10_000 });
    reg.abandon();
    await expect(p1).rejects.toBeInstanceOf(RpcAbandonedError);
    await expect(p2).rejects.toBeInstanceOf(RpcAbandonedError);
    expect(reg.size()).toBe(0);
  });

  test('evicts oldest and rejects with RpcBusyError on overflow', async () => {
    const reg = createPendingRegistry({ capacity: 2 });
    const p1 = reg.register({ correlationId: 'c1', deadlineMs: Date.now() + 10_000 });
    const p2 = reg.register({ correlationId: 'c2', deadlineMs: Date.now() + 10_000 });
    const p3 = reg.register({ correlationId: 'c3', deadlineMs: Date.now() + 10_000 });
    await expect(p1).rejects.toBeInstanceOf(RpcBusyError);
    // c2 and c3 remain; settle one to release it.
    reg.settle('c2', { status: 'ok', data: 'ok' });
    await expect(p2).resolves.toEqual({ status: 'ok', data: 'ok' });
    reg.settle('c3', { status: 'ok', data: 'ok3' });
    await expect(p3).resolves.toEqual({ status: 'ok', data: 'ok3' });
  });

  test('duplicate correlationId registration rejects', async () => {
    const reg = createPendingRegistry();
    const first = reg.register({ correlationId: 'c1', deadlineMs: Date.now() + 1000 });
    first.catch(() => {}); // suppress the eventual timer rejection
    await expect(
      reg.register({ correlationId: 'c1', deadlineMs: Date.now() + 1000 }),
    ).rejects.toThrow(/already registered/);
    reg.abandon();
    await expect(first).rejects.toBeDefined();
  });

  test('settles with status: error when response carries an error', async () => {
    const reg = createPendingRegistry();
    const p = reg.register({ correlationId: 'c1', deadlineMs: Date.now() + 1000 });
    reg.settle('c1', { status: 'error', error: { code: 'E_X', message: 'boom' } });
    await expect(p).resolves.toEqual({
      status: 'error',
      error: { code: 'E_X', message: 'boom' },
    });
  });

  test('rejects capacity <= 0 at construction', () => {
    expect(() => createPendingRegistry({ capacity: 0 })).toThrow();
    expect(() => createPendingRegistry({ capacity: -1 })).toThrow();
  });
});
