import { Database } from 'bun:sqlite';
import { type Mailbox, createMailbox } from '@declaragent/core';
import { sessionsDbPath } from './paths.js';

export interface AdminCliIO {
  out: (s: string) => void;
  err: (s: string) => void;
}

const STDIO_IO: AdminCliIO = {
  out: (s) => process.stdout.write(s),
  err: (s) => process.stderr.write(s),
};

export interface MailboxCliDeps {
  io?: AdminCliIO;
  /** Inject a mailbox. When omitted, opens `sessionsDbPath()`. */
  mailbox?: Mailbox;
}

function resolveMailbox(deps: MailboxCliDeps): { mailbox: Mailbox; close(): void } {
  if (deps.mailbox) return { mailbox: deps.mailbox, close: () => {} };
  const db = new Database(sessionsDbPath(), { create: true, readwrite: true });
  return {
    mailbox: createMailbox({ db }),
    close: () => db.close(),
  };
}

/** `declaragent mailbox depth <agent-id>` */
export async function mailboxDepth(agent: string, deps: MailboxCliDeps = {}): Promise<number> {
  const io = deps.io ?? STDIO_IO;
  if (!agent) {
    io.err('✗ agent id is required\n');
    return 1;
  }
  const { mailbox, close } = resolveMailbox(deps);
  try {
    const n = await mailbox.depth(agent);
    io.out(`${n}\n`);
    return 0;
  } finally {
    close();
  }
}

/**
 * `declaragent mailbox drain <agent-id>` — admin-only drain. Note: if
 * the daemon is running, its in-memory depth cache may be briefly stale
 * until the next lookup. The SQLite-backed queue is always authoritative.
 */
export async function mailboxDrain(agent: string, deps: MailboxCliDeps = {}): Promise<number> {
  const io = deps.io ?? STDIO_IO;
  if (!agent) {
    io.err('✗ agent id is required\n');
    return 1;
  }
  const { mailbox, close } = resolveMailbox(deps);
  try {
    const drained = await mailbox.drainFor(agent);
    if (drained.length === 0) {
      io.out('mailbox is empty.\n');
      return 0;
    }
    io.out(`drained ${drained.length} event(s):\n`);
    for (const e of drained) {
      io.out(`${JSON.stringify(e)}\n`);
    }
    return 0;
  } finally {
    close();
  }
}
