import { resolve } from 'node:path';
import type { Tool } from '../types/tool.js';

export interface EditInput {
  path: string;
  oldString: string;
  newString: string;
  replaceAll?: boolean;
}

export interface EditOutput {
  path: string;
  replacements: number;
}

function countOccurrences(haystack: string, needle: string): number {
  if (needle.length === 0) return 0;
  let count = 0;
  let index = haystack.indexOf(needle);
  while (index !== -1) {
    count += 1;
    index = haystack.indexOf(needle, index + needle.length);
  }
  return count;
}

export const Edit: Tool<EditInput, EditOutput> = {
  name: 'Edit',
  description:
    'Replace `oldString` with `newString` in a file. Default requires `oldString` to appear exactly once; pass `replaceAll: true` to substitute every occurrence.',
  inputSchema: {
    type: 'object',
    properties: {
      path: { type: 'string' },
      oldString: { type: 'string' },
      newString: { type: 'string' },
      replaceAll: { type: 'boolean' },
    },
    required: ['path', 'oldString', 'newString'],
  },
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
      const original = await file.text();
      if (ctx.abortSignal.aborted) {
        yield {
          type: 'error',
          error: { code: 'ABORTED', message: 'Edit aborted' },
        };
        return;
      }
      if (input.oldString === input.newString) {
        yield {
          type: 'error',
          error: {
            code: 'EINVAL',
            message: 'oldString and newString are identical',
          },
        };
        return;
      }
      const occurrences = countOccurrences(original, input.oldString);
      if (occurrences === 0) {
        yield {
          type: 'error',
          error: {
            code: 'ENOMATCH',
            message: 'oldString not found in file',
          },
        };
        return;
      }
      if (!input.replaceAll && occurrences > 1) {
        yield {
          type: 'error',
          error: {
            code: 'EAMBIGUOUS',
            message: `oldString matches ${occurrences} times; pass replaceAll: true or supply more context`,
          },
        };
        return;
      }
      const next = input.replaceAll
        ? original.split(input.oldString).join(input.newString)
        : original.replace(input.oldString, input.newString);
      await Bun.write(absolute, next);
      yield {
        type: 'result',
        output: {
          path: absolute,
          replacements: input.replaceAll ? occurrences : 1,
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
