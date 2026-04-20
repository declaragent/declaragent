import { chmodSync, existsSync, unlinkSync } from 'node:fs';
import { type Server, type Socket, createServer } from 'node:net';
import {
  type ControlResponse,
  type Daemon,
  NDJSONDecoder,
  encodeControlMessage,
  handleControlRequest,
  isControlRequest,
} from '@declaragent/core';

export interface DaemonSocketServer {
  readonly socketPath: string;
  close(): Promise<void>;
}

export interface StartDaemonSocketOptions {
  daemon: Daemon;
  socketPath: string;
  /** Unlink an existing socket file if present. Default true (orphan from a crash). */
  force?: boolean;
}

/**
 * Bind a Unix socket server that accepts length-terminated NDJSON control
 * messages. Each message decodes to a `ControlRequest`; the server calls
 * `handleControlRequest` on the daemon and writes the response back on
 * the same socket.
 *
 * The socket file is chmod'd to 0600 so only the owning user can speak
 * to the daemon. If `options.force` is true (default) and a stale socket
 * exists, it's unlinked first — typical after an unclean shutdown.
 */
export async function startDaemonSocket(
  options: StartDaemonSocketOptions,
): Promise<DaemonSocketServer> {
  const { daemon, socketPath } = options;
  const force = options.force ?? true;

  if (force && existsSync(socketPath)) {
    try {
      unlinkSync(socketPath);
    } catch {
      // If the path isn't a socket, unlink can still succeed; swallow.
    }
  }

  const server: Server = createServer((socket) => handleConnection(daemon, socket));

  await new Promise<void>((resolve, reject) => {
    const onError = (err: Error): void => {
      server.removeListener('listening', onListening);
      reject(err);
    };
    const onListening = (): void => {
      server.removeListener('error', onError);
      resolve();
    };
    server.once('error', onError);
    server.once('listening', onListening);
    server.listen(socketPath);
  });

  try {
    chmodSync(socketPath, 0o600);
  } catch {
    // Non-fatal: on some filesystems chmod is a no-op. The socket still
    // exists on the local FS and is reachable only via filesystem perms.
  }

  return {
    socketPath,
    async close(): Promise<void> {
      await new Promise<void>((resolve) => {
        server.close(() => resolve());
      });
      if (existsSync(socketPath)) {
        try {
          unlinkSync(socketPath);
        } catch {
          // ignore
        }
      }
    },
  };
}

function handleConnection(daemon: Daemon, socket: Socket): void {
  const decoder = new NDJSONDecoder();
  socket.setEncoding('utf8');

  socket.on('data', async (chunk: string | Buffer) => {
    const text = typeof chunk === 'string' ? chunk : chunk.toString('utf8');
    const parsed = decoder.push(text);
    for (const entry of parsed) {
      if (!isControlRequest(entry)) {
        // Malformed/invalid: drop. A stricter protocol could echo an
        // error — for now we're forgiving to keep the CLI simple.
        continue;
      }
      try {
        const response = await handleControlRequest(daemon, entry);
        writeResponse(socket, response);
      } catch (err) {
        writeResponse(socket, {
          id: entry.id,
          method: entry.method,
          error: {
            code: 'EUNHANDLED',
            message: err instanceof Error ? err.message : String(err),
          },
        } as ControlResponse);
      }
    }
  });

  socket.on('error', () => {
    // Client disconnected or write failed; no-op.
  });
}

function writeResponse(socket: Socket, response: ControlResponse): void {
  try {
    socket.write(encodeControlMessage(response));
  } catch {
    // Best-effort; socket may be closed already.
  }
}
