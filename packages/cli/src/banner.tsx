import { homedir } from 'node:os';
import { Box, Text } from 'ink';

export const APP_VERSION = '0.0.1';

function shortCwd(cwd = process.cwd(), home = homedir()): string {
  if (cwd === home) return '~';
  if (cwd.startsWith(`${home}/`)) return `~${cwd.slice(home.length)}`;
  return cwd;
}

interface Props {
  providerId: string;
  model: string;
  mode: string;
  source?: string;
}

const GLYPH = ['   ___   ', '  (oo)~  ', '   /||\\  '];

/**
 * Startup banner. Three lines: a small elephant glyph on the left and
 * identity / context on the right. Only rendered once at startup; flows
 * with the scrollback above the input box.
 */
export function Banner({ providerId, model, mode, source }: Props): JSX.Element {
  const right: string[] = [
    `Declaragent v${APP_VERSION}`,
    `${providerId}/${model} · ${mode}${source ? ` (${source})` : ''}`,
    shortCwd(),
  ];
  // Each glyph row is unique enough to use as its own key.
  return (
    <Box flexDirection="column" marginBottom={1}>
      {GLYPH.map((g, i) => (
        <Text key={g}>
          <Text color="cyan">{g}</Text>
          <Text color="gray"> {right[i] ?? ''}</Text>
        </Text>
      ))}
    </Box>
  );
}
