import { resolve } from 'node:path';
import type { Tool } from '../types/tool.js';

export interface GrepInput {
  pattern: string;
  path?: string;
  glob?: string;
  caseInsensitive?: boolean;
  maxMatches?: number;
}

export interface GrepMatch {
  file: string;
  line: number;
  text: string;
}

export interface GrepOutput {
  pattern: string;
  cwd: string;
  matches: GrepMatch[];
  filesScanned: number;
  truncated: boolean;
}

const DEFAULT_MAX_MATCHES = 1000;

function permissionKey(input: GrepInput): string {
  const cwd = resolve(input.path ?? process.cwd());
  const fileGlob = input.glob ?? '**/*';
  return `${cwd}:${fileGlob}:${input.pattern}`;
}

export const Grep: Tool<GrepInput, GrepOutput> = {
  name: 'Grep',
  description:
    'Search file contents by regex across files matching `glob` (default `**/*`) rooted at `path` (default cwd).',
  inputSchema: {
    type: 'object',
    properties: {
      pattern: { type: 'string', description: 'Regex pattern.' },
      path: { type: 'string' },
      glob: { type: 'string' },
      caseInsensitive: { type: 'boolean' },
      maxMatches: { type: 'integer', minimum: 1 },
    },
    required: ['pattern'],
  },
  readonly: true,
  permissionKey,
  async *execute(input, ctx) {
    const cwd = resolve(input.path ?? process.cwd());
    const maxMatches = input.maxMatches ?? DEFAULT_MAX_MATCHES;
    let regex: RegExp;
    try {
      regex = new RegExp(input.pattern, input.caseInsensitive ? 'i' : '');
    } catch (err) {
      yield {
        type: 'error',
        error: {
          code: 'EINVAL',
          message: `Invalid regex: ${(err as Error).message}`,
        },
      };
      return;
    }

    const fileGlob = new Bun.Glob(input.glob ?? '**/*');
    const matches: GrepMatch[] = [];
    let filesScanned = 0;
    let truncated = false;

    try {
      for await (const file of fileGlob.scan({ cwd, absolute: true, onlyFiles: true })) {
        if (ctx.abortSignal.aborted) {
          yield {
            type: 'error',
            error: { code: 'ABORTED', message: 'Grep scan aborted' },
          };
          return;
        }
        filesScanned += 1;
        let text: string;
        try {
          text = await Bun.file(file).text();
        } catch {
          // Unreadable / binary; skip.
          continue;
        }
        const lines = text.split('\n');
        for (let i = 0; i < lines.length; i += 1) {
          const line = lines[i] ?? '';
          if (regex.test(line)) {
            matches.push({ file, line: i + 1, text: line });
            if (matches.length >= maxMatches) {
              truncated = true;
              break;
            }
          }
        }
        if (truncated) break;
        if (filesScanned % 50 === 0) {
          yield { type: 'progress', message: `scanned ${filesScanned} files` };
        }
      }
      yield {
        type: 'result',
        output: {
          pattern: input.pattern,
          cwd,
          matches,
          filesScanned,
          truncated,
        },
      };
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
