import { type Socket, connect } from 'node:net';
import {
  type ControlRequest,
  type ControlResponse,
  NDJSONDecoder,
  encodeControlMessage,
} from '@declaragent/core';

export interface DaemonClient {
  call(request: ControlRequest): Promise<ControlResponse>;
  close(): void;
}

/**
 * Open a client connection to a daemon Unix socket. Multiple `call`s can
 * share one client. Requests are correlated by `id`; the NDJSON framing
 * is inherited from the server.
 */
export async function connectDaemonClient(socketPath: string): Promise<DaemonClient> {
  const socket: Socket = await new Promise<Socket>((resolve, reject) => {
    const s = connect(socketPath);
    s.setEncoding('utf8');
    const onErr = (err: Error): void => {
      s.removeListener('connect', onConn);
      reject(err);
    };
    const onConn = (): void => {
      s.removeListener('error', onErr);
      resolve(s);
    };
    s.once('error', onErr);
    s.once('connect', onConn);
  });

  const decoder = new NDJSONDecoder();
  const pending = new Map<string, (resp: ControlResponse) => void>();

  socket.on('data', (chunk: string | Buffer) => {
    const text = typeof chunk === 'string' ? chunk : chunk.toString('utf8');
    const parsed = decoder.push(text);
    for (const entry of parsed) {
      if (!entry || typeof entry !== 'object' || !('id' in entry)) continue;
      const id = (entry as { id: string }).id;
      const resolver = pending.get(id);
      if (resolver) {
        pending.delete(id);
        resolver(entry as ControlResponse);
      }
    }
  });

  let closed = false;
  socket.on('close', () => {
    closed = true;
    // Reject any outstanding requests so callers don't hang.
    for (const [id, resolver] of pending) {
      resolver({
        id,
        method: 'status',
        error: { code: 'ESOCKETCLOSED', message: 'daemon socket closed before response' },
      } as ControlResponse);
    }
    pending.clear();
  });

  return {
    async call(request: ControlRequest): Promise<ControlResponse> {
      if (closed) {
        return {
          id: request.id,
          method: request.method,
          error: { code: 'ESOCKETCLOSED', message: 'daemon socket is closed' },
        } as ControlResponse;
      }
      return new Promise<ControlResponse>((resolve) => {
        pending.set(request.id, resolve);
        socket.write(encodeControlMessage(request));
      });
    },
    close(): void {
      if (!closed) {
        closed = true;
        socket.end();
      }
    },
  };
}
