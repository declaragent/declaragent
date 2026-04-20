import { dirname, resolve } from 'node:path';
import type { Tool } from '../types/tool.js';

export interface WriteInput {
  path: string;
  content: string;
  createDirs?: boolean;
}

export interface WriteOutput {
  path: string;
  bytesWritten: number;
  created: boolean;
}

export const Write: Tool<WriteInput, WriteOutput> = {
  name: 'Write',
  description:
    'Write content to a file, replacing any existing contents. Set `createDirs: true` to mkdir -p the parent directory.',
  inputSchema: {
    type: 'object',
    properties: {
      path: { type: 'string', description: 'Absolute path to the file.' },
      content: { type: 'string' },
      createDirs: { type: 'boolean' },
    },
    required: ['path', 'content'],
  },
  permissionKey: ({ path }) => resolve(path),
  async *execute(input, ctx) {
    const absolute = resolve(input.path);
    try {
      const existed = await Bun.file(absolute).exists();
      if (input.createDirs) {
        const { mkdir } = await import('node:fs/promises');
        await mkdir(dirname(absolute), { recursive: true });
      }
      if (ctx.abortSignal.aborted) {
        yield {
          type: 'error',
          error: { code: 'ABORTED', message: 'Write aborted' },
        };
        return;
      }
      const bytesWritten = await Bun.write(absolute, input.content);
      yield {
        type: 'result',
        output: { path: absolute, bytesWritten, created: !existed },
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
