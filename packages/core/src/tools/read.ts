import { resolve } from 'node:path';
import type { Tool } from '../types/tool.js';

export interface ReadInput {
  path: string;
  offset?: number;
  limit?: number;
}

export interface ReadOutput {
  path: string;
  content: string;
  truncated: boolean;
  totalLines: number;
}

export const Read: Tool<ReadInput, ReadOutput> = {
  name: 'Read',
  description:
    'Read the contents of a file. Optional `offset` (1-indexed line) and `limit` (max lines) select a slice.',
  inputSchema: {
    type: 'object',
    properties: {
      path: { type: 'string', description: 'Absolute path to the file.' },
      offset: { type: 'integer', minimum: 1 },
      limit: { type: 'integer', minimum: 1 },
    },
    required: ['path'],
  },
  readonly: true,
  permissionKey: ({ path }) => resolve(path),
  async *execute(input, ctx) {
    const absolute = resolve(input.path);
    try {
      const file = Bun.file(absolute);
      if (!(await file.exists())) {
        yield {
          type: 'error',
          error: { code: 'ENOENT', message: `File not found: ${absolute}` },
        };
        return;
      }
      const text = await file.text();
      if (ctx.abortSignal.aborted) {
        yield {
          type: 'error',
          error: { code: 'ABORTED', message: 'Read aborted' },
        };
        return;
      }
      const lines = text.split('\n');
      const offset = input.offset ?? 1;
      const start = Math.max(0, offset - 1);
      const end = input.limit !== undefined ? start + input.limit : lines.length;
      const sliced = lines.slice(start, end);
      yield {
        type: 'result',
        output: {
          path: absolute,
          content: sliced.join('\n'),
          truncated: end < lines.length || start > 0,
          totalLines: lines.length,
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
