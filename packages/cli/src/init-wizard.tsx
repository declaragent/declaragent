import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import {
  type LLMProvider,
  createAnthropicProvider,
  createOpenAICompatProvider,
} from '@declaragent/core';
import { Box, Text, useApp, useInput } from 'ink';
import TextInput from 'ink-text-input';
import { useState } from 'react';
import { resolveCredentials } from './auth.js';
import { initializedMarkerPath, telemetryOptOutPath } from './init-paths.js';
import {
  TEMPLATE_NAMES,
  type TemplateName,
  type UnpackFS,
  type UnpackResult,
  getTemplateDescription,
  isTemplateName,
  listTemplates,
  unpackTemplate,
} from './init-template-unpacker.js';
import { configDir } from './paths.js';
import { type ProviderPreset, getPreset } from './providers-registry.js';

export interface InitWizardIO {
  out: (s: string) => void;
  err: (s: string) => void;
}

const STDIO_IO: InitWizardIO = {
  out: (s) => process.stdout.write(s),
  err: (s) => process.stderr.write(s),
};

export interface InitOptions {
  outDir: string;
  force: boolean;
  multiTenant: boolean;
  skipVerify?: boolean;
  template?: string;
  provider?: string;
  tenantId?: string;
}

/** Injected deps — lets tests drive the non-interactive path without Ink or disk. */
export interface InitWizardDeps {
  io?: InitWizardIO;
  fs?: UnpackFS;
  /** Override the marker-file path. Defaults to `initializedMarkerPath()`. */
  markerPath?: string;
  /** Override the telemetry opt-out path. */
  telemetryOptOutPath?: string;
  /** Env map — defaults to `process.env`. */
  env?: Record<string, string | undefined>;
  /** Build the provider used for the verify-`hello` call. Injectable for tests. */
  makeVerifyProvider?: (preset: ProviderPreset) => LLMProvider;
  /** Optional one-shot verify hook — overrides the full makeProvider pipeline. */
  verify?: (preset: ProviderPreset) => Promise<void>;
  /** Launch the interactive Ink wizard. Tests stay non-interactive. */
  launchInteractive?: (options: InitOptions) => Promise<number>;
}

// --------------------------------------------------------------------------
// Non-interactive orchestrator (pure, tested)
// --------------------------------------------------------------------------

export async function runInit(options: InitOptions, deps: InitWizardDeps = {}): Promise<number> {
  const io = deps.io ?? STDIO_IO;
  const env = deps.env ?? process.env;

  if (options.provider && !getPreset(options.provider)) {
    io.err(`✗ unknown provider "${options.provider}". Run \`declaragent auth login\` to list.\n`);
    return 1;
  }
  if (options.template && !isTemplateName(options.template)) {
    io.err(`✗ unknown template "${options.template}". Known: ${TEMPLATE_NAMES.join(', ')}.\n`);
    return 1;
  }

  const fullyNonInteractive = options.provider !== undefined && options.template !== undefined;
  if (!fullyNonInteractive) {
    if (!deps.launchInteractive) {
      io.err(
        '✗ interactive wizard not available in this context. Pass --provider <id> --template <name> to run non-interactively.\n',
      );
      return 1;
    }
    return deps.launchInteractive(options);
  }

  const preset = getPreset(options.provider as string) as ProviderPreset;
  const template = options.template as TemplateName;
  const outDir = resolve(options.outDir);

  const proxy = env.HTTPS_PROXY ?? env.https_proxy;
  if (proxy) {
    io.out(`ℹ using HTTPS_PROXY=${proxy}\n`);
  }

  let unpacked: UnpackResult;
  try {
    unpacked = unpackTemplate(
      {
        template,
        outDir,
        providerId: preset.id,
        providerEnvVar: preset.envVar ?? '',
        force: options.force,
        multiTenant: options.multiTenant,
        ...(options.tenantId !== undefined && { tenantId: options.tenantId }),
      },
      deps.fs,
    );
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    io.err(`✗ ${msg}\n`);
    return 1;
  }

  for (const path of unpacked.written) {
    io.out(`  wrote ${path}\n`);
  }

  writeMarker(deps);

  if (options.skipVerify) {
    io.out(`✓ init complete — template "${template}" scaffolded under ${outDir}.\n`);
    return 0;
  }

  const verifyCode = await runVerify(preset, io, deps);
  if (verifyCode !== 0) return verifyCode;

  io.out(
    `✓ init complete — template "${template}" (${getTemplateDescription(template)}) under ${outDir}.\n`,
  );
  return 0;
}

function writeMarker(deps: InitWizardDeps): void {
  const markerPath = deps.markerPath ?? initializedMarkerPath();
  try {
    if (deps.fs) {
      deps.fs.writeFile(markerPath, `${new Date().toISOString()}\n`);
      return;
    }
    mkdirSync(dirname(markerPath), { recursive: true });
    writeFileSync(markerPath, `${new Date().toISOString()}\n`, 'utf8');
  } catch {
    // Non-fatal; the wizard will just re-prompt telemetry next run.
  }
}

async function runVerify(
  preset: ProviderPreset,
  io: InitWizardIO,
  deps: InitWizardDeps,
): Promise<number> {
  if (deps.verify) {
    try {
      await deps.verify(preset);
      io.out('✓ verify — one hello turn succeeded.\n');
      return 0;
    } catch (err) {
      return reportVerifyFailure(err, preset, io);
    }
  }

  // When the caller injects an env map, treat it as the authoritative source
  // (tests pass a minimal env; we don't want saved ~/.declaragent/config.json
  // leaking in). Production callers pass no env and get the normal pairing
  // of process.env + loadConfig().
  const creds = deps.env
    ? resolveCredentials(deps.env, null)
    : resolveCredentials(deps.env ?? process.env);
  if (!creds || creds.providerId !== preset.id) {
    io.err(
      `✗ verify skipped — no credentials resolved for provider "${preset.id}". Run \`declaragent auth login ${preset.id}\` and re-run init.\n`,
    );
    return 1;
  }

  let provider: LLMProvider;
  try {
    provider = deps.makeVerifyProvider
      ? deps.makeVerifyProvider(preset)
      : buildVerifyProvider(preset, creds.apiKey ?? '', creds.authToken, creds.baseURL);
  } catch (err) {
    return reportVerifyFailure(err, preset, io);
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 30_000);
  try {
    const res = await provider.complete(
      {
        model: preset.defaultModel ?? 'claude-opus-4-6',
        system: 'You are a smoke test. Reply with one word: hello.',
        messages: [
          {
            role: 'user',
            content: [{ type: 'text', text: 'hello' }],
          },
        ],
        tools: [],
        maxTokens: 32,
      },
      controller.signal,
    );
    const hasText = res.content.some((c) => c.type === 'text' && c.text.length > 0);
    if (!hasText) {
      io.err('✗ verify — provider returned no text content.\n');
      return 1;
    }
    io.out('✓ verify — one hello turn succeeded.\n');
    return 0;
  } catch (err) {
    return reportVerifyFailure(err, preset, io);
  } finally {
    clearTimeout(timer);
  }
}

function buildVerifyProvider(
  preset: ProviderPreset,
  apiKey: string,
  authToken: string | undefined,
  baseURL: string | undefined,
): LLMProvider {
  if (preset.kind === 'anthropic') {
    return createAnthropicProvider({
      ...(apiKey && { apiKey }),
      ...(authToken !== undefined && { authToken }),
      ...(baseURL !== undefined && { baseURL }),
      ...(preset.defaultModel !== undefined && { defaultModel: preset.defaultModel }),
    });
  }
  const effectiveBase = baseURL ?? preset.baseURL;
  if (!effectiveBase) {
    throw new Error(`provider "${preset.id}" has no baseURL configured.`);
  }
  return createOpenAICompatProvider({
    baseURL: effectiveBase,
    apiKey: apiKey || authToken || '',
    ...(preset.headers && { headers: preset.headers }),
  });
}

function reportVerifyFailure(err: unknown, preset: ProviderPreset, io: InitWizardIO): number {
  const msg = err instanceof Error ? err.message : String(err);
  io.err(`✗ verify failed: ${msg}\n`);
  const lower = msg.toLowerCase();
  if (lower.includes('401') || lower.includes('unauthorized') || lower.includes('api key')) {
    io.err(`  → fix: \`declaragent auth login ${preset.id}\` and re-run init.\n`);
  } else if (
    lower.includes('enotfound') ||
    lower.includes('econnrefused') ||
    lower.includes('timeout') ||
    lower.includes('network')
  ) {
    io.err('  → fix: check network / set HTTPS_PROXY if you are behind a corp proxy.\n');
  } else {
    io.err('  → fix: re-run with --skip-verify to scaffold anyway, then debug separately.\n');
  }
  return 1;
}

// --------------------------------------------------------------------------
// Interactive Ink wizard (welcome + telemetry opt-out + template pick).
// Provider auth stays orchestrated at the outer runInitSubcommand layer —
// the existing AuthLogin / AuthOpenRouter flows each own their Ink instance.
// --------------------------------------------------------------------------

interface WizardProps {
  onDone: (result: WizardResult) => void;
}

export interface WizardResult {
  template: TemplateName;
  tenantId?: string;
  multiTenantToggled: boolean;
}

export function InitWizard({
  onDone,
  initialMultiTenant = false,
}: WizardProps & { initialMultiTenant?: boolean }): JSX.Element {
  type Stage = 'welcome' | 'tenant-id' | 'template';
  const [stage, setStage] = useState<Stage>('welcome');
  const [multiTenant, setMultiTenant] = useState(initialMultiTenant);
  const [tenantId, setTenantId] = useState<string | undefined>(undefined);

  if (stage === 'welcome') {
    return (
      <WelcomeStep
        onDone={() => {
          setStage(multiTenant ? 'tenant-id' : 'template');
        }}
      />
    );
  }
  if (stage === 'tenant-id') {
    return (
      <TenantIdStep
        onSubmit={(id) => {
          setTenantId(id);
          setStage('template');
        }}
      />
    );
  }
  return (
    <TemplatePicker
      multiTenant={multiTenant}
      onToggleMultiTenant={() => {
        const next = !multiTenant;
        setMultiTenant(next);
        if (next) setStage('tenant-id');
      }}
      onSelect={(template) => {
        onDone({
          template,
          multiTenantToggled: multiTenant !== initialMultiTenant,
          ...(tenantId !== undefined && { tenantId }),
        });
      }}
    />
  );
}

function WelcomeStep({ onDone }: { onDone: () => void }): JSX.Element {
  const { exit } = useApp();
  const [decided, setDecided] = useState(false);

  useInput((input, key) => {
    if (decided) return;
    if (input === 'o' || input === 'O') {
      try {
        mkdirSync(configDir(), { recursive: true });
        writeFileSync(telemetryOptOutPath(), `${new Date().toISOString()}\n`, 'utf8');
      } catch {
        // Non-fatal.
      }
      setDecided(true);
      onDone();
      return;
    }
    if (key.return || input === 'y' || input === 'Y' || input === 'a' || input === 'A') {
      setDecided(true);
      onDone();
      return;
    }
    if (key.escape) exit();
  });

  return (
    <Box flexDirection="column">
      <Text color="cyan">Welcome to declaragent.</Text>
      <Text>Anonymous telemetry helps us improve the CLI.</Text>
      <Text>It is off-by-default for anything touching user code and never ships secrets.</Text>
      <Box marginTop={1}>
        <Text>
          <Text color="cyan">Enter</Text> accept · <Text color="cyan">o</Text> opt out ·{' '}
          <Text color="cyan">esc</Text> cancel
        </Text>
      </Box>
    </Box>
  );
}

function TenantIdStep({ onSubmit }: { onSubmit: (id: string) => void }): JSX.Element {
  const [value, setValue] = useState('');
  return (
    <Box flexDirection="column">
      <Text color="cyan">Tenant id for the multi-tenant scaffold:</Text>
      <Box marginTop={1}>
        <Text color="cyan">› </Text>
        <TextInput
          value={value}
          onChange={setValue}
          onSubmit={(v) => onSubmit(v.trim() || 'default')}
        />
      </Box>
    </Box>
  );
}

interface TemplatePickerProps {
  multiTenant: boolean;
  onToggleMultiTenant: () => void;
  onSelect: (name: TemplateName) => void;
}

function TemplatePicker({
  multiTenant,
  onToggleMultiTenant,
  onSelect,
}: TemplatePickerProps): JSX.Element {
  const items = listTemplates();
  const [cursor, setCursor] = useState(0);

  useInput((input, key) => {
    if (key.upArrow) {
      setCursor((c) => Math.max(0, c - 1));
      return;
    }
    if (key.downArrow) {
      setCursor((c) => Math.min(items.length - 1, c + 1));
      return;
    }
    if (input === 't' || input === 'T') {
      onToggleMultiTenant();
      return;
    }
    if (key.return) {
      const chosen = items[cursor];
      if (chosen) onSelect(chosen.name);
    }
  });

  return (
    <Box flexDirection="column">
      <Text color="cyan">Choose a template:</Text>
      {items.map((t, i) => {
        const selected = i === cursor;
        return (
          <Text key={t.name} color={selected ? 'cyan' : 'white'}>
            {selected ? '▶ ' : '  '}
            <Text color={selected ? 'cyan' : 'white'}>{t.name.padEnd(22)}</Text>
            <Text color="gray">{t.description}</Text>
          </Text>
        );
      })}
      <Text color="gray">
        ↑/↓ navigate · enter select · T {multiTenant ? 'disable' : 'enable'} multi-tenant
      </Text>
    </Box>
  );
}

/**
 * Internal helper exposed for tests that want to assert the non-interactive
 * path fails gracefully without a `launchInteractive` hook.
 */
export const INTERACTIVE_FALLBACK_HINT =
  'Pass --provider <id> --template <name> to run non-interactively.';
