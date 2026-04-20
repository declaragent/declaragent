import { Box, Text, useApp, useInput } from 'ink';
import { useState } from 'react';
import { type ProviderPreset, listPresets } from './providers-registry.js';

interface Props {
  onSelect: (preset: ProviderPreset) => void;
}

const PRESETS = listPresets();

/**
 * Arrow-key picker for choosing which provider to authenticate.
 * Shown by `auth login` when no provider is supplied as an arg.
 */
export function AuthProviderPicker({ onSelect }: Props): JSX.Element {
  const { exit } = useApp();
  const [cursor, setCursor] = useState(0);

  useInput((_inputChar, key) => {
    if (key.upArrow) {
      setCursor((c) => Math.max(0, c - 1));
      return;
    }
    if (key.downArrow) {
      setCursor((c) => Math.min(PRESETS.length - 1, c + 1));
      return;
    }
    if (key.escape) {
      exit();
      return;
    }
    if (key.return) {
      const chosen = PRESETS[cursor];
      if (chosen) onSelect(chosen);
    }
  });

  return (
    <Box flexDirection="column">
      <Text color="cyan">Choose a provider:</Text>
      {PRESETS.map((p, i) => {
        const selected = i === cursor;
        return (
          <Text key={p.id} color={selected ? 'cyan' : 'white'}>
            {selected ? '▶ ' : '  '}
            <Text color={selected ? 'cyan' : 'white'}>{p.id.padEnd(12)}</Text>
            <Text color="gray"> {p.label}</Text>
            {p.authMethod === 'browser-pkce' ? (
              <Text color="yellow"> [browser]</Text>
            ) : p.authMethod === 'env-only' ? (
              <Text color="green"> [local]</Text>
            ) : null}
          </Text>
        );
      })}
      <Text color="gray"> ↑/↓ navigate · enter select · esc cancel</Text>
    </Box>
  );
}
