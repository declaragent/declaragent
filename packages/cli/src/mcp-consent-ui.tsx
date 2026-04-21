import type { PluginMCPServerSpec } from '@declaragent/core';
import { Box, Text, useApp, useInput } from 'ink';
import { useEffect, useState } from 'react';
import type { MCPScope } from './mcp-runtime.js';

interface Props {
  spec: PluginMCPServerSpec;
  scope: MCPScope;
  onDecision: (approved: boolean) => void;
}

/**
 * Ink consent UI shown by `declaragent up` the first time a configured
 * MCP server is seen. Matches the plugin-consent UX — `y` approves,
 * `N`/Esc rejects, Enter rejects (consent is opt-in).
 */
export function MCPConsentUI({ spec, scope, onDecision }: Props): JSX.Element {
  const { exit } = useApp();
  const [decided, setDecided] = useState<'approve' | 'reject' | null>(null);

  useInput((input, key) => {
    if (decided !== null) return;
    if (input === 'y' || input === 'Y') {
      setDecided('approve');
      onDecision(true);
    } else if (input === 'n' || input === 'N' || key.escape || (key.ctrl && input === 'c')) {
      setDecided('reject');
      onDecision(false);
    } else if (key.return) {
      setDecided('reject');
      onDecision(false);
    }
  });

  useEffect(() => {
    if (decided !== null) {
      setTimeout(() => exit(), 50);
    }
  }, [decided, exit]);

  if (decided === 'approve') {
    return <Text color="green">✓ approved MCP server {spec.name}</Text>;
  }
  if (decided === 'reject') {
    return <Text color="red">✗ skipped MCP server {spec.name} — no consent</Text>;
  }

  return (
    <Box flexDirection="column">
      <Text>
        Start MCP server <Text color="cyan">{spec.name}</Text>?
      </Text>
      <Text color="gray">scope: {scope}</Text>

      <Box marginTop={1} flexDirection="column">
        <Text color="yellow">Transport:</Text>
        {spec.transport.type === 'stdio' ? (
          <>
            <Text>{`  command: ${spec.transport.command}`}</Text>
            {spec.transport.args && spec.transport.args.length > 0 ? (
              <Text>{`  args:    ${spec.transport.args.join(' ')}`}</Text>
            ) : null}
          </>
        ) : (
          <Text>{`  url: ${spec.transport.url}`}</Text>
        )}
        <Text>{`  protocol: ${spec.protocolVersion}`}</Text>
      </Box>

      <Box marginTop={1}>
        <Text color="gray">MCP servers run as subprocesses and expose tools</Text>
      </Box>
      <Text color="gray">your agent can invoke — approve only what you trust.</Text>

      <Box marginTop={1}>
        <Text>
          Approve? <Text color="cyan">y</Text>/<Text color="cyan">N</Text>{' '}
        </Text>
      </Box>
    </Box>
  );
}
