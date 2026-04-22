import type { Tool, ToolContext, ToolEvent } from '../../../../types/tool.js';

export const tools: Tool[] = [
  {
    name: 'EchoFromPlugin',
    description: 'Fixture tool contributed by plugin-sample.',
    inputSchema: { type: 'object', properties: { msg: { type: 'string' } } },
    permissionKey: () => 'echo',
    async *execute(input: unknown, _ctx: ToolContext): AsyncIterable<ToolEvent> {
      const msg = (input as { msg?: string } | null)?.msg ?? '';
      yield { type: 'result', output: `echo:${msg}` };
    },
  },
];
