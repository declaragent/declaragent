/**
 * `DeclaraAuthPlaybook` builder tool — returns a short markdown guide
 * that walks the user through credentialing a given provider. See
 * BUILDER_PLAN §7 phase 2.
 *
 * This is a pure lookup — no side effects, no filesystem writes, no
 * network calls. Safe to run in readonly mode. The REPL renders the
 * output as a system message so the user sees the steps inline.
 *
 * @since 0.2.0
 */

import type { Tool, ToolEvent } from '@declaragent/core';
import {
  AUTH_PLAYBOOK_PROVIDERS,
  getAuthPlaybook,
  isAuthPlaybookProvider,
} from './auth-playbooks.js';
import {
  type AuthPlaybookInput,
  type AuthPlaybookOutput,
  BuilderValidationError,
  authPlaybookInputSchema,
  formatZodError,
} from './types.js';

export function createAuthPlaybookTool(): Tool<AuthPlaybookInput, AuthPlaybookOutput> {
  return {
    name: 'DeclaraAuthPlaybook',
    description: `Return a concise auth-setup playbook for a supported provider. Pure lookup — no file writes, no network. Supported providers: ${AUTH_PLAYBOOK_PROVIDERS.join(', ')}.`,
    inputSchema: {
      type: 'object',
      properties: {
        provider: { type: 'string', enum: [...AUTH_PLAYBOOK_PROVIDERS] },
      },
      required: ['provider'],
    },
    readonly: true,
    parallelSafe: true,
    permissionKey(input) {
      return `playbook:${input.provider}`;
    },
    async *execute(input, _toolCtx): AsyncIterable<ToolEvent<AuthPlaybookOutput>> {
      const parsed = authPlaybookInputSchema.safeParse(input);
      if (!parsed.success) {
        yield {
          type: 'error',
          error: {
            code: 'E_BUILDER_VALIDATION',
            message: `DeclaraAuthPlaybook: ${formatZodError(parsed.error)}`,
          },
        };
        return;
      }
      const { provider } = parsed.data;
      if (!isAuthPlaybookProvider(provider)) {
        yield {
          type: 'error',
          error: {
            code: 'E_BUILDER_VALIDATION',
            message: new BuilderValidationError(
              `unknown provider "${provider}" — known: ${AUTH_PLAYBOOK_PROVIDERS.join(', ')}`,
            ).message,
          },
        };
        return;
      }
      yield {
        type: 'result',
        output: {
          ok: true,
          provider,
          content: getAuthPlaybook(provider),
        },
      };
    },
  };
}
