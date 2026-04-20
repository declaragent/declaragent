import type { PluginManifest } from '@declaragent/core';
import { Box, Text, useApp, useInput } from 'ink';
import { useEffect, useState } from 'react';

interface Props {
  manifest: PluginManifest;
  pluginDir: string;
  onDecision: (approved: boolean) => void;
}

/**
 * Ink consent UI shown by `declaragent plugin install <path>`.
 * Lists every permission the plugin will be granted and every kind of
 * extension it will register. The user's `y` / `N` decision drives the
 * caller's persistence path (write vs. discard).
 */
export function PluginConsent({ manifest, pluginDir, onDecision }: Props): JSX.Element {
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
      // Enter ⇒ default = reject (consent is opt-in).
      setDecided('reject');
      onDecision(false);
    }
  });

  useEffect(() => {
    if (decided !== null) {
      // Give Ink a tick to flush the final frame before tearing down.
      setTimeout(() => exit(), 50);
    }
  }, [decided, exit]);

  if (decided === 'approve') {
    return <Text color="green">✓ approved {manifest.name}</Text>;
  }
  if (decided === 'reject') {
    return <Text color="red">✗ install cancelled — nothing was changed</Text>;
  }

  return (
    <Box flexDirection="column">
      <Text>
        Install plugin{' '}
        <Text color="cyan">
          {manifest.name}@{manifest.version}
        </Text>
        ?
      </Text>
      {manifest.description ? <Text color="gray">{manifest.description}</Text> : null}
      <Text color="gray">from {pluginDir}</Text>

      <Box marginTop={1} flexDirection="column">
        <Text color="yellow">Permissions it will be granted:</Text>
        {manifest.permissions.length === 0 ? (
          <Text color="gray"> (none declared)</Text>
        ) : (
          manifest.permissions.map((p) => (
            <Text key={p} color="white">
              {'  • '}
              {p}
            </Text>
          ))
        )}
      </Box>

      <Box marginTop={1} flexDirection="column">
        <Text color="yellow">It will register:</Text>
        <Text>{`  tools:      ${manifest.contributes.tools.length}`}</Text>
        <Text>{`  skills:     ${manifest.contributes.skills.length}`}</Text>
        <Text>
          {`  mcpServers: ${manifest.contributes.mcpServers.length}`}
          {manifest.contributes.mcpServers.length > 0
            ? ` (${manifest.contributes.mcpServers.map((s) => s.name).join(', ')})`
            : ''}
        </Text>
        <Text>{`  hooks:      ${manifest.contributes.hooks.length}`}</Text>
        <Text>{`  commands:   ${manifest.contributes.commands.length}`}</Text>
      </Box>

      <Box marginTop={1}>
        <Text color="gray">Plugins run in this process — installing one is trust-equivalent</Text>
      </Box>
      <Text color="gray">to running its code directly.</Text>

      <Box marginTop={1}>
        <Text>
          Approve? <Text color="cyan">y</Text>/<Text color="cyan">N</Text>{' '}
        </Text>
      </Box>
    </Box>
  );
}
