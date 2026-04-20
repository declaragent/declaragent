import { Box, Text, useApp } from 'ink';
import TextInput from 'ink-text-input';
import { useState } from 'react';
import { configPath, maskCredential, setProviderCreds } from './auth.js';
import type { ProviderPreset } from './providers-registry.js';

interface Props {
  preset: ProviderPreset;
}

type Stage = 'input' | 'saved' | 'empty';

/**
 * Generic paste-an-API-key flow. Used for any preset whose `authMethod` is
 * `'api-key'` (Anthropic, OpenAI, Groq, DeepSeek, Together, Mistral, xAI).
 */
export function AuthLogin({ preset }: Props): JSX.Element {
  const { exit } = useApp();
  const [value, setValue] = useState('');
  const [stage, setStage] = useState<Stage>('input');

  function submit(v: string): void {
    const trimmed = v.trim();
    if (trimmed.length === 0) {
      setStage('empty');
      return;
    }
    setProviderCreds(preset.id, { apiKey: trimmed });
    setStage('saved');
    setTimeout(() => exit(), 50);
  }

  if (stage === 'saved') {
    return (
      <Box flexDirection="column">
        <Text color="green">
          ✓ saved {preset.id} {maskCredential(value)}
        </Text>
        <Text color="gray">→ {configPath()}</Text>
      </Box>
    );
  }
  if (stage === 'empty') {
    return (
      <Box flexDirection="column">
        <Text color="red">empty input — nothing saved</Text>
      </Box>
    );
  }

  return (
    <Box flexDirection="column">
      <Text>
        Paste your API key for <Text color="cyan">{preset.label}</Text>:
      </Text>
      {preset.keyURL ? <Text color="gray">Get one at {preset.keyURL}</Text> : null}
      <Box marginTop={1}>
        <Text color="cyan">› </Text>
        <TextInput value={value} onChange={setValue} onSubmit={submit} mask="*" />
      </Box>
    </Box>
  );
}
