import type { Tool } from '../types/tool.js';

export interface BashInput {
  command: string;
  timeoutMs?: number;
  cwd?: string;
}

export interface BashOutput {
  command: string;
  exitCode: number;
  stdout: string;
  stderr: string;
  durationMs: number;
  timedOut: boolean;
}

export const DEFAULT_BASH_TIMEOUT_MS = 120_000;
export const MAX_OUTPUT_BYTES = 1_000_000;

function truncate(buf: string): string {
  if (buf.length <= MAX_OUTPUT_BYTES) return buf;
  return `${buf.slice(0, MAX_OUTPUT_BYTES)}\n…[truncated ${buf.length - MAX_OUTPUT_BYTES} bytes]`;
}

export const Bash: Tool<BashInput, BashOutput> = {
  name: 'Bash',
  description:
    'Run a shell command. Output is captured from stdout and stderr; exit code is returned. Default timeout is 120 seconds.',
  inputSchema: {
    type: 'object',
    properties: {
      command: { type: 'string' },
      timeoutMs: { type: 'integer', minimum: 1 },
      cwd: { type: 'string' },
    },
    required: ['command'],
  },
  permissionKey: ({ command }) => command,
  async *execute(input, ctx) {
    const timeoutMs = input.timeoutMs ?? DEFAULT_BASH_TIMEOUT_MS;
    const started = performance.now();

    const controller = new AbortController();
    const abortForwarder = () => controller.abort();
    ctx.abortSignal.addEventListener('abort', abortForwarder, { once: true });

    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      controller.abort();
    }, timeoutMs);

    try {
      const proc = Bun.spawn({
        cmd: ['/bin/sh', '-c', input.command],
        stdout: 'pipe',
        stderr: 'pipe',
        ...(input.cwd !== undefined && { cwd: input.cwd }),
        signal: controller.signal,
      });

      const [stdout, stderr, exitCode] = await Promise.all([
        new Response(proc.stdout).text(),
        new Response(proc.stderr).text(),
        proc.exited,
      ]);
      const durationMs = performance.now() - started;

      yield {
        type: 'result',
        output: {
          command: input.command,
          exitCode,
          stdout: truncate(stdout),
          stderr: truncate(stderr),
          durationMs,
          timedOut,
        },
      };
    } catch (err) {
      yield {
        type: 'error',
        error: {
          code: timedOut ? 'ETIMEDOUT' : 'EEXEC',
          message: err instanceof Error ? err.message : String(err),
          cause: err,
        },
      };
    } finally {
      clearTimeout(timer);
      ctx.abortSignal.removeEventListener('abort', abortForwarder);
    }
  },
};
