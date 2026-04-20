/**
 * Thin wrapper over `docker` / `docker compose` for pausing, killing,
 * and restarting a containerized broker. Used by the broker-restart
 * acceptance scenario. Keeps the CLI surface narrow so tests that
 * don't have docker on the host can still import this module.
 */

import { spawn } from 'node:child_process';

export interface DockerControl {
  kill(container: string, signal?: 'SIGTERM' | 'SIGKILL' | 'SIGSTOP' | 'SIGCONT'): Promise<void>;
  start(container: string): Promise<void>;
  restart(container: string): Promise<void>;
}

export interface DockerControlOptions {
  /** Timeout for individual docker commands (ms). Default 15_000. */
  timeoutMs?: number;
  /** Logger callback for each executed command. */
  logCommand?: (line: string) => void;
}

export function createDockerControl(options: DockerControlOptions = {}): DockerControl {
  const timeoutMs = options.timeoutMs ?? 15_000;
  const log = options.logCommand;

  async function runDocker(args: readonly string[]): Promise<void> {
    if (log) log(`docker ${args.join(' ')}`);
    await new Promise<void>((resolve, reject) => {
      const p = spawn('docker', args, { stdio: ['ignore', 'pipe', 'pipe'] });
      let stderr = '';
      const timer = setTimeout(() => {
        p.kill('SIGKILL');
        reject(new Error(`docker ${args.join(' ')} timed out after ${timeoutMs}ms`));
      }, timeoutMs);
      p.stderr.on('data', (d: Buffer) => {
        stderr += d.toString('utf-8');
      });
      p.on('close', (code) => {
        clearTimeout(timer);
        if (code === 0) resolve();
        else reject(new Error(`docker ${args.join(' ')} exited with ${code}: ${stderr.trim()}`));
      });
      p.on('error', (err) => {
        clearTimeout(timer);
        reject(err);
      });
    });
  }

  return {
    async kill(container, signal = 'SIGKILL') {
      await runDocker(['kill', '--signal', signal, container]);
    },
    async start(container) {
      await runDocker(['start', container]);
    },
    async restart(container) {
      await runDocker(['restart', container]);
    },
  };
}
