import { resolve } from 'node:path';
import type { Tool } from '../types/tool.js';

export interface GlobInput {
  pattern: string;
  path?: string;
}

export interface GlobOutput {
  pattern: string;
  cwd: string;
  matches: string[];
}

/**
 * Permission key combines cwd and pattern so rules can gate by search root
 * (e.g., `Glob:/project/**:*.ts`).
 */
function permissionKey(input: GlobInput): string {
  const cwd = resolve(input.path ?? process.cwd());
  return `${cwd}:${input.pattern}`;
}

export const GlobTool: Tool<GlobInput, GlobOutput> = {
  name: 'Glob',
  description:
    'List files matching a glob pattern (e.g., `**/*.ts`). Optional `path` sets the search root; defaults to cwd.',
  inputSchema: {
    type: 'object',
    properties: {
      pattern: { type: 'string' },
      path: { type: 'string' },
    },
    required: ['pattern'],
  },
  readonly: true,
  permissionKey,
  async *execute(input, ctx) {
    const cwd = resolve(input.path ?? process.cwd());
    try {
      const glob = new Bun.Glob(input.pattern);
      const matches: string[] = [];
      for await (const match of glob.scan({ cwd, absolute: true, onlyFiles: true })) {
        if (ctx.abortSignal.aborted) {
          yield {
            type: 'error',
            error: { code: 'ABORTED', message: 'Glob scan aborted' },
          };
          return;
        }
        matches.push(match);
      }
      matches.sort();
      yield { type: 'result', output: { pattern: input.pattern, cwd, matches } };
    } catch (err) {
      yield {
        type: 'error',
        error: {
          message: err instanceof Error ? err.message : String(err),
          cause: err,
        },
      };
    }
  },
};
