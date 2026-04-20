import { homedir } from 'node:os';
import { Box, Text } from 'ink';
import { CLI_VERSION } from './version.js';

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

/**
 * ASCII translation of the web brandmark — lowercase `d` in a rounded
 * square. Rendered in accent (teal) on lines 1–3. Identity info
 * (version / provider+model / cwd) sits to the right on each line.
 *
 *   ╭───╮  Declaragent v0.1.3
 *   │ d │  anthropic/claude-opus-4-6 · default
 *   ╰───╯  ~/my-agent
 */
const GLYPH = ['╭───╮', '│ d │', '╰───╯'];

export function Banner({ providerId, model, mode, source }: Props): JSX.Element {
  const right: string[] = [
    `Declaragent v${CLI_VERSION}`,
    `${providerId}/${model} · ${mode}${source ? ` (${source})` : ''}`,
    shortCwd(),
  ];
  return (
    <Box flexDirection="column" marginBottom={1}>
      {GLYPH.map((g, i) => (
        <Text key={g}>
          <Text color="cyan">{g}</Text>
          <Text color="gray">  {right[i] ?? ''}</Text>
        </Text>
      ))}
    </Box>
  );
}
