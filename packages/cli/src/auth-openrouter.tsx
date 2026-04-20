import { Box, Text, useApp } from 'ink';
import { useEffect, useState } from 'react';
import { configPath, maskCredential, setProviderCreds } from './auth.js';
import { FALLBACK_CALLBACK_PORTS, runOpenRouterOAuth } from './openrouter-oauth.js';

type Stage = 'starting' | 'awaiting' | 'saved' | 'error';

interface Props {
  callbackPort?: number;
}

export function AuthOpenRouter(props: Props = {}): JSX.Element {
  const { exit } = useApp();
  const [stage, setStage] = useState<Stage>('starting');
  const [authUrl, setAuthUrl] = useState('');
  const [keyMasked, setKeyMasked] = useState('');
  const [errorMsg, setErrorMsg] = useState('');

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const preferredPorts = props.callbackPort
          ? [props.callbackPort, ...FALLBACK_CALLBACK_PORTS]
          : FALLBACK_CALLBACK_PORTS;
        const result = await runOpenRouterOAuth(
          (url) => {
            if (cancelled) return;
            setAuthUrl(url);
            setStage('awaiting');
          },
          { preferredPorts },
        );
        if (cancelled) return;
        setProviderCreds('openrouter', { apiKey: result.key });
        setKeyMasked(maskCredential(result.key));
        setStage('saved');
        setTimeout(() => exit(), 50);
      } catch (err) {
        if (cancelled) return;
        setErrorMsg(err instanceof Error ? err.message : String(err));
        setStage('error');
        setTimeout(() => exit(), 50);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [exit, props.callbackPort]);

  if (stage === 'starting') {
    return <Text color="yellow">Generating PKCE challenge…</Text>;
  }
  if (stage === 'awaiting') {
    return (
      <Box flexDirection="column">
        <Text>Opening your browser to OpenRouter…</Text>
        <Text color="gray">If it doesn't open, visit:</Text>
        <Text color="cyan">{authUrl}</Text>
        <Box marginTop={1}>
          <Text color="yellow">… waiting for callback (5 min timeout)</Text>
        </Box>
      </Box>
    );
  }
  if (stage === 'saved') {
    return (
      <Box flexDirection="column">
        <Text color="green">✓ saved openrouter {keyMasked}</Text>
        <Text color="gray">→ {configPath()}</Text>
      </Box>
    );
  }
  return (
    <Box flexDirection="column">
      <Text color="red">OAuth failed: {errorMsg}</Text>
    </Box>
  );
}
