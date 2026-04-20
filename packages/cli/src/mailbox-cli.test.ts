import { Database } from 'bun:sqlite';
import { describe, expect, test } from 'bun:test';
import { createMailbox } from '@declaragent/core';
import { mailboxDepth, mailboxDrain } from './mailbox-cli.js';

function makeMailbox(): ReturnType<typeof createMailbox> {
  const db = new Database(':memory:', { create: true });
  return createMailbox({ db });
}

function captureIO(): {
  out: string[];
  err: string[];
  io: { out: (s: string) => void; err: (s: string) => void };
} {
  const out: string[] = [];
  const err: string[] = [];
  return {
    out,
    err,
    io: {
      out: (s) => out.push(s),
      err: (s) => err.push(s),
    },
  };
}

describe('mailboxDepth', () => {
  test('prints 0 for an empty mailbox', async () => {
    const mailbox = makeMailbox();
    const { out, io } = captureIO();
    const code = await mailboxDepth('bob', { mailbox, io });
    expect(code).toBe(0);
    expect(out.join('').trim()).toBe('0');
  });

  test('prints the pending count', async () => {
    const mailbox = makeMailbox();
    await mailbox.send('bob', { hello: 'world' }, 'alice');
    await mailbox.send('bob', { again: true }, 'alice');
    const { out, io } = captureIO();
    const code = await mailboxDepth('bob', { mailbox, io });
    expect(code).toBe(0);
    expect(out.join('').trim()).toBe('2');
  });

  test('rejects empty agent', async () => {
    const mailbox = makeMailbox();
    const { err, io } = captureIO();
    const code = await mailboxDepth('', { mailbox, io });
    expect(code).toBe(1);
    expect(err.join('')).toContain('required');
  });
});

describe('mailboxDrain', () => {
  test('drains pending events and prints JSON lines', async () => {
    const mailbox = makeMailbox();
    await mailbox.send('bob', { n: 1 }, 'alice');
    await mailbox.send('bob', { n: 2 }, 'alice');
    const { out, io } = captureIO();
    const code = await mailboxDrain('bob', { mailbox, io });
    expect(code).toBe(0);
    const text = out.join('');
    expect(text).toContain('drained 2 event(s)');
    const jsonLines = text
      .split('\n')
      .filter((l) => l.startsWith('{'))
      .map((l) => JSON.parse(l));
    expect(jsonLines).toHaveLength(2);
    expect(jsonLines[0].payload).toEqual({ n: 1 });
  });

  test('reports empty mailbox without draining', async () => {
    const mailbox = makeMailbox();
    const { out, io } = captureIO();
    const code = await mailboxDrain('bob', { mailbox, io });
    expect(code).toBe(0);
    expect(out.join('')).toContain('empty');
  });
});
