import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { promises as fsp } from 'node:fs';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createLogTailer } from './log-tail.js';

/**
 * Helper: read up to `n` lines from a tailer with a deadline. Returns
 * whatever we collected before `timeoutMs` elapses so a stalled
 * tailer surfaces as a short array rather than a hung test.
 */
async function drain(
  tailer: ReturnType<typeof createLogTailer>,
  n: number,
  timeoutMs = 1500,
): Promise<string[]> {
  const out: string[] = [];
  const iter = tailer[Symbol.asyncIterator]();
  const deadline = Date.now() + timeoutMs;
  while (out.length < n && Date.now() < deadline) {
    const race = await Promise.race([
      iter.next(),
      new Promise<'timeout'>((resolve) => {
        setTimeout(() => resolve('timeout'), deadline - Date.now()).unref?.();
      }),
    ]);
    if (race === 'timeout') break;
    if (race.done) break;
    out.push(race.value.line);
  }
  return out;
}

describe('createLogTailer', () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'dgt-log-tail-'));
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('emits lines appended after tailer start (tail -f semantics)', async () => {
    const path = join(dir, 'agent-a.log');
    await fsp.writeFile(path, 'pre-existing\n', 'utf8');
    const tailer = createLogTailer({ paths: [{ path }], pollIntervalMs: 40 });
    // Give the initial EOF-seek a beat, then append.
    await new Promise((r) => setTimeout(r, 60));
    await fsp.appendFile(path, 'live-1\nlive-2\n');
    const lines = await drain(tailer, 2);
    expect(lines).toEqual(['live-1', 'live-2']);
    await tailer.destroy();
    expect(tailer.closed).toBe(true);
  });

  it('picks up a file created after the tailer starts', async () => {
    const path = join(dir, 'agent-late.log');
    const tailer = createLogTailer({ paths: [{ path }], pollIntervalMs: 40 });
    await new Promise((r) => setTimeout(r, 60));
    await fsp.writeFile(path, 'first\nsecond\n', 'utf8');
    const lines = await drain(tailer, 2);
    expect(lines).toEqual(['first', 'second']);
    await tailer.destroy();
  });

  it('replays from offset 0 when fromStart=true', async () => {
    const path = join(dir, 'agent-history.log');
    await fsp.writeFile(path, 'old-1\nold-2\n', 'utf8');
    const tailer = createLogTailer({ paths: [{ path }], pollIntervalMs: 40, fromStart: true });
    const lines = await drain(tailer, 2);
    expect(lines).toEqual(['old-1', 'old-2']);
    await tailer.destroy();
  });

  it('handles rotation via rm + new file (inode change resets offset)', async () => {
    const path = join(dir, 'rotate.log');
    await fsp.writeFile(path, 'gen-1-a\n', 'utf8');
    const tailer = createLogTailer({ paths: [{ path }], pollIntervalMs: 40 });
    await new Promise((r) => setTimeout(r, 60));
    await fsp.appendFile(path, 'gen-1-b\n');
    const firstBatch = await drain(tailer, 1);
    expect(firstBatch).toEqual(['gen-1-b']);

    // Rotate: remove + recreate. The new inode forces offset=0.
    await fsp.unlink(path);
    await fsp.writeFile(path, 'gen-2-a\ngen-2-b\n', 'utf8');
    const secondBatch = await drain(tailer, 2);
    expect(secondBatch).toEqual(['gen-2-a', 'gen-2-b']);
    await tailer.destroy();
  });

  it('stashes partial trailing lines across reads', async () => {
    const path = join(dir, 'partial.log');
    await fsp.writeFile(path, '', 'utf8');
    const tailer = createLogTailer({ paths: [{ path }], pollIntervalMs: 40 });
    await new Promise((r) => setTimeout(r, 60));
    // Write a line in two halves — the first chunk has no newline, so
    // the tailer must NOT emit anything for it.
    await fsp.appendFile(path, 'half-');
    await new Promise((r) => setTimeout(r, 80));
    await fsp.appendFile(path, 'one\n');
    const lines = await drain(tailer, 1);
    expect(lines).toEqual(['half-one']);
    await tailer.destroy();
  });

  it('destroy() resolves pending next() calls and is idempotent', async () => {
    const path = join(dir, 'shutdown.log');
    await fsp.writeFile(path, '', 'utf8');
    const tailer = createLogTailer({ paths: [{ path }], pollIntervalMs: 40 });
    const pending = tailer[Symbol.asyncIterator]().next();
    await tailer.destroy();
    const result = await pending;
    expect(result.done).toBe(true);
    expect(tailer.closed).toBe(true);
    // second destroy should be a no-op (no throw)
    await tailer.destroy();
  });

  it('falls back to polling when watchFactory returns null (network-FS path)', async () => {
    const path = join(dir, 'poll-only.log');
    await fsp.writeFile(path, '', 'utf8');
    const tailer = createLogTailer({
      paths: [{ path }],
      pollIntervalMs: 40,
      watchFactory: () => null,
    });
    await new Promise((r) => setTimeout(r, 60));
    await fsp.appendFile(path, 'poll-1\npoll-2\n');
    const lines = await drain(tailer, 2);
    expect(lines).toEqual(['poll-1', 'poll-2']);
    await tailer.destroy();
  });

  it('multiplexes multiple paths, tagging lines with the correct agentId', async () => {
    const pathA = join(dir, 'agent-a.log');
    const pathB = join(dir, 'agent-b.log');
    await fsp.writeFile(pathA, '', 'utf8');
    await fsp.writeFile(pathB, '', 'utf8');
    const tailer = createLogTailer({
      paths: [
        { path: pathA, agentId: 'a' },
        { path: pathB, agentId: 'b' },
      ],
      pollIntervalMs: 40,
    });
    await new Promise((r) => setTimeout(r, 60));
    await fsp.appendFile(pathA, 'from-a\n');
    await fsp.appendFile(pathB, 'from-b\n');

    const seenA: string[] = [];
    const seenB: string[] = [];
    const iter = tailer[Symbol.asyncIterator]();
    const deadline = Date.now() + 1500;
    while (seenA.length + seenB.length < 2 && Date.now() < deadline) {
      const race = await Promise.race([
        iter.next(),
        new Promise<'timeout'>((resolve) => {
          setTimeout(() => resolve('timeout'), Math.max(50, deadline - Date.now())).unref?.();
        }),
      ]);
      if (race === 'timeout') break;
      if (race.done) break;
      if (race.value.agentId === 'a') seenA.push(race.value.line);
      else if (race.value.agentId === 'b') seenB.push(race.value.line);
    }
    expect(seenA).toEqual(['from-a']);
    expect(seenB).toEqual(['from-b']);
    await tailer.destroy();
  });
});
