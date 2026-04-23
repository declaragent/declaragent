#!/usr/bin/env bun
import type { PermissionMode } from '@declaragent/core';
import type { DispatchOutcome, EventKind } from '@declaragent/core';
import { render } from 'ink';
import { App } from './app.js';
import type { AuditQueryArgs } from './audit-cli.js';
import { auditErase, auditPrune, auditQuery, auditVerify } from './audit-cli.js';
import { AuthLogin } from './auth-login.js';
import { AuthOpenRouter } from './auth-openrouter.js';
import { AuthProviderPicker } from './auth-provider-picker.js';
import {
  clearConfig,
  configPath,
  maskCredential,
  resolveCredentials,
  setProviderCreds,
} from './auth.js';
import { capabilitiesGen } from './capabilities-gen-cli.js';
import { daemonReload, daemonShutdown, daemonStart, daemonStatus } from './daemon-cli.js';
import { deployGcpCloudRun, verifyGcpCloudRunDeploy } from './deploy-cli.js';
import { dlqList, dlqRedrive, dlqShow } from './dlq-cli.js';
import {
  dlqDispatchDrop,
  dlqDispatchList,
  dlqDispatchRequeue,
  dlqDispatchShow,
} from './dlq-dispatch-cli.js';
import { down } from './down-cli.js';
import { eventsList, eventsReplay, eventsReplayRange, eventsShow } from './events-cli.js';
import { eventsConfigValidate } from './events-config-cli.js';
import { extensionsList } from './extensions-cli.js';
import { fleetAdd } from './fleet-add-cli.js';
import { fleetAuditRpc } from './fleet-audit-rpc-cli.js';
import { fleetCapabilities, fleetList, fleetValidate } from './fleet-cli.js';
import { fleetDlqList, fleetEventsList, fleetLogs, fleetPs } from './fleet-cross-host-cli.js';
import { fleetDeploy } from './fleet-deploy-cli.js';
import { type GraphFormat, fleetGraph } from './fleet-graph-cli.js';
import { fleetInit } from './fleet-init-cli.js';
import { fleetPeers } from './fleet-peers-cli.js';
import { fleetDemote, fleetPromote } from './fleet-promote-cli.js';
import { fleetRender } from './fleet-render-cli.js';
import { fleetRun } from './fleet-run.js';
import { fleetStatus } from './fleet-status-cli.js';
import { type InitOptions, InitWizard, type WizardResult, runInit } from './init-wizard.js';
import { logs as tailLogs } from './logs-cli.js';
import { mailboxDepth, mailboxDrain } from './mailbox-cli.js';
import {
  mcpAdd,
  mcpApprove,
  mcpList,
  mcpLogin,
  mcpLogout,
  mcpRemove,
  mcpRevoke,
} from './mcp-cli.js';
import type { MCPScope } from './mcp-runtime.js';
import { migrateConfig } from './migrate-cli.js';
import { pluginInfo, pluginInstall, pluginList, pluginRemove } from './plugin-cli.js';
import { PluginConsent } from './plugin-consent.js';
import { type ProviderPreset, getPreset, listPresets } from './providers-registry.js';
import { ps as listUp } from './ps-cli.js';
import { secretsDescribe, secretsList, secretsRotate } from './secrets-cli.js';
import { skillList } from './skill-cli.js';
import { sourceAdaptersList } from './source-adapters-cli.js';
import { sourceAdd, sourceList, sourceRemove } from './source-cli.js';
import { tenantsDiff, tenantsList, tenantsShow } from './tenants-cli.js';
import { DETACHED_SENTINEL, up } from './up-cli.js';
import { CLI_VERSION } from './version.js';

interface ParsedArgs {
  mode?: PermissionMode;
  model?: string;
  help?: boolean;
  version?: boolean;
  apiKey?: string;
  callbackPort?: number;
}

function parseArgs(argv: string[]): ParsedArgs {
  const out: ParsedArgs = {};
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--help' || arg === '-h') {
      out.help = true;
    } else if (arg === '--version' || arg === '-v') {
      out.version = true;
    } else if (arg === '--mode') {
      const v = argv[i + 1];
      if (v === 'default' || v === 'plan' || v === 'bypass' || v === 'auto') {
        out.mode = v;
      }
      i += 1;
    } else if (arg === '--model') {
      const v = argv[i + 1];
      if (v) out.model = v;
      i += 1;
    } else if (arg === '--api-key') {
      const v = argv[i + 1];
      if (v) out.apiKey = v;
      i += 1;
    } else if (arg === '--callback-port') {
      const v = argv[i + 1];
      const n = v ? Number.parseInt(v, 10) : Number.NaN;
      if (Number.isFinite(n) && n > 0 && n < 65536) out.callbackPort = n;
      i += 1;
    }
  }
  return out;
}

function printHelp(): void {
  const presets = listPresets();
  const cloudIds = presets.filter((p) => p.hosting === 'cloud').map((p) => p.id);
  const localIds = presets.filter((p) => p.hosting === 'local').map((p) => p.id);
  process.stdout.write(`declaragent — interactive REPL

Usage:
  declaragent [--mode <default|plan|bypass|auto>] [--model <model>]
  declaragent auth login [<provider>] [--api-key <key>] [--callback-port <n>]
  declaragent auth status
  declaragent auth logout

  declaragent plugin install <path> [--yes]
  declaragent plugin list
  declaragent plugin info <id>
  declaragent plugin remove <id>

  declaragent skill list

  declaragent mcp add <name> --command <cmd> [--args a,b,c] [--protocol <ver>]
  declaragent mcp list
  declaragent mcp remove <name>

  declaragent extensions

  declaragent up [-d|--detach] [-f <path>]         # bring agents online (compose-like)
  declaragent down                                  # stop agents brought up by \`up\`
  declaragent ps                                    # list bound agents + sources
  declaragent logs [-f|--follow] [<agent-id>]       # tail per-agent event logs

  declaragent daemon                                # legacy user-global daemon
  declaragent daemon-status
  declaragent daemon-reload
  declaragent daemon-shutdown [--no-drain]

  declaragent events list [--kind <k>] [--last <n>] [--correlation <id>] [--outcome <kind>] [--state circuit-open]
  declaragent events show <id>
  declaragent events replay <id>
  declaragent events replay-range --source <id> --from <ms> [--to <ms>] [--limit <n>] [--filter <expr>] [--no-dispatch]

  declaragent dlq list --source <id> [--since <ms>] [--limit <n>]
  declaragent dlq show --source <id> <entryId>
  declaragent dlq redrive --source <id> <entryId>
  declaragent dlq list --kind dispatch [--reason <r>] [--min-attempts <n>] [--since <ms>] [--limit <n>]
  declaragent dlq show --kind dispatch <eventId>
  declaragent dlq drop --kind dispatch <eventId>
  declaragent dlq requeue --kind dispatch <eventId> [--agent <id>]

  declaragent events-config validate [path]

  declaragent source list
  declaragent source add <type> <id> --config '<json>' | --config-file <path>
  declaragent source remove <type:id | id>
  declaragent source-adapters list

  declaragent mailbox depth <agent-id>
  declaragent mailbox drain <agent-id>

  declaragent fleet new <name> [--out <dir>] [--force]
  declaragent fleet add --template <name> [--id <id>] [--force]
  declaragent fleet add --path <dir> [--id <id>] [--force]
  declaragent fleet promote <path> [--apply] [--id <id>] [--force]
  declaragent fleet demote [<id>] [--force]
  declaragent fleet run [--agent <id>...]
  declaragent fleet deploy [--target <name>] [--agent <id>...] [--strategy <rolling|all-or-nothing|per-agent>]
  declaragent fleet deploy --dry-run | --rollback | --target-config <path>
  declaragent fleet render --target <k8s|helm> [--format <helm|kustomize>] [--out <dir>] [--image <ref>] [--replicas <n>] [--namespace <ns>] [--with-servicemonitor|--no-servicemonitor] [--config-split]
  declaragent fleet graph [--format <mermaid|dot|json>]
  declaragent fleet peers [--verify] [--json]
  declaragent fleet status [--history] [--limit <n>] [--json]
  declaragent fleet list [--json]
  declaragent fleet validate [--json]
  declaragent fleet capabilities [--json]
  declaragent fleet audit-rpc [--suggest-enable] [--strict] [--json]
  declaragent fleet ps [--host <name>] [--json]                                # cross-host status fan-out (#50)
  declaragent fleet events [--host <name>] [--kind <k>] [--since <ms>] [--state circuit-open] [--outcome <k>] [--correlation <id>] [--limit <n>] [--all] [--json]
  declaragent fleet dlq [--host <name>] [--reason <r>] [--min-attempts <n>] [--since <ms>] [--limit <n>] [--all] [--json]
  declaragent fleet logs [-f | --follow] [--host <name>] [--agent <id>] [--max-lines <n>] [--json]

  declaragent capabilities gen --peer <id> [--out <dir>]
  declaragent capabilities gen --capabilities <path> [--out <dir>] [--json]

  declaragent init --fleet <name> [--out <dir>] [--force]   # shortcut for \`fleet new\`

  declaragent tenants list [--json]
  declaragent tenants show <id> [--json]
  declaragent tenants diff [--json]

  declaragent audit query [--tenant X] [--kind Y] [--since ms] [--until ms] [--limit N] [--json]
  declaragent audit verify [--tenant X] [--json]
  declaragent audit erase --user <platformUserId> [--reason R] [--json]
  declaragent audit prune --tenant <id> --retention-days <N> [--json]

  declaragent secrets list [--provider <name>] [--json]
  declaragent secrets describe <ref> [--json]
  declaragent secrets rotate <ref> [--tenant X] [--reason R] [--json]

  declaragent init [--out <dir>] [--force] [--multi-tenant] [--template <name>] [--provider <id>]

  declaragent deploy gcp-cloud-run [--out <dir>] [--force] [--project <id>] [--region <r>]
                                   [--service <name>] [--cpu <n>] [--memory-mib <n>]
                                   [--min-instances <n>] [--verify] [--json]

  declaragent migrate [--config-dir <path>] [--apply] [--json]

Providers:
  cloud:  ${cloudIds.join(', ')}
  local:  ${localIds.join(', ')}

Flags:
  --mode      Permission mode (default: default — prompts on each tool call)
  --model     Model id to use for this session.
  --version   Print the declaragent version.
  --help      Show this message.

Environment (per-provider, see registry for the full list):
  ANTHROPIC_API_KEY, OPENAI_API_KEY, OPENROUTER_API_KEY, GROQ_API_KEY,
  DEEPSEEK_API_KEY, TOGETHER_API_KEY, MISTRAL_API_KEY, XAI_API_KEY, ...

Credential file: ${configPath()}
Slash commands inside the REPL: /help
`);
}

function runAuthStatus(): void {
  const creds = resolveCredentials();
  if (!creds) {
    process.stdout.write(
      `no credentials configured.
  • Run \`declaragent auth login\` to choose a provider, or
  • Set one of the supported env vars (see --help).
`,
    );
    process.exit(1);
  }
  const value = creds.authToken ?? creds.apiKey ?? '';
  process.stdout.write(`provider: ${creds.providerId}\n`);
  process.stdout.write(`source:   ${creds.source}\n`);
  if (creds.envVar) process.stdout.write(`env var:  ${creds.envVar}\n`);
  process.stdout.write(`value:    ${value ? maskCredential(value) : '(none — local provider)'}\n`);
  if (creds.baseURL) process.stdout.write(`baseURL:  ${creds.baseURL}\n`);
  process.stdout.write(`config:   ${configPath()}\n`);
}

function runAuthLogout(): void {
  const removed = clearConfig();
  process.stdout.write(removed ? `removed ${configPath()}\n` : 'nothing to remove\n');
}

function runApiKeyLoginNonInteractive(preset: ProviderPreset, key: string): void {
  setProviderCreds(preset.id, { apiKey: key });
  process.stdout.write(`✓ saved ${preset.id} ${maskCredential(key)} → ${configPath()}\n`);
}

function runLocalLogin(preset: ProviderPreset): void {
  setProviderCreds(preset.id, {});
  process.stdout.write(`✓ activated ${preset.id} (local; baseURL=${preset.baseURL})\n`);
}

const argv = process.argv.slice(2);
const args = parseArgs(argv);
if (args.version) {
  process.stdout.write(`declaragent ${CLI_VERSION}\n`);
  process.exit(0);
}
if (args.help && argv[0] !== 'init' && argv[0] !== 'migrate' && argv[0] !== 'deploy') {
  printHelp();
  process.exit(0);
}

function launchRepl(): void {
  const props: { initialMode?: PermissionMode; model?: string } = {};
  if (args.mode) props.initialMode = args.mode;
  if (args.model) props.model = args.model;
  render(<App {...props} />, { exitOnCtrlC: false });
}

async function runInkFlow(element: JSX.Element): Promise<void> {
  const instance = render(element);
  await instance.waitUntilExit();
}

async function runProviderAuth(preset: ProviderPreset): Promise<void> {
  if (preset.authMethod === 'env-only') {
    runLocalLogin(preset);
    return;
  }
  if (args.apiKey) {
    runApiKeyLoginNonInteractive(preset, args.apiKey);
    return;
  }
  if (preset.authMethod === 'browser-pkce' && preset.id === 'openrouter') {
    await runInkFlow(
      <AuthOpenRouter
        {...(args.callbackPort !== undefined && { callbackPort: args.callbackPort })}
      />,
    );
    return;
  }
  await runInkFlow(<AuthLogin preset={preset} />);
}

function parseList(value: string | undefined): string[] | undefined {
  if (!value) return undefined;
  return value
    .split(',')
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}

async function runPluginSubcommand(
  action: string | undefined,
  rest: readonly string[],
): Promise<number> {
  if (action === 'install') {
    const target = rest.find((arg) => !arg.startsWith('--'));
    if (!target) {
      process.stderr.write('usage: declaragent plugin install <path> [--yes]\n');
      return 1;
    }
    const skipConsent = rest.includes('--yes') || rest.includes('-y');
    const consent = skipConsent
      ? async () => true
      : async (manifest: import('@declaragent/core').PluginManifest, pluginDir: string) =>
          new Promise<boolean>((resolveBool) => {
            let decided = false;
            const instance = render(
              <PluginConsent
                manifest={manifest}
                pluginDir={pluginDir}
                onDecision={(approved) => {
                  decided = true;
                  resolveBool(approved);
                }}
              />,
            );
            void instance.waitUntilExit().then(() => {
              if (!decided) resolveBool(false);
            });
          });
    return pluginInstall(target, { consent });
  }
  if (action === 'list') return pluginList();
  if (action === 'info') {
    const id = rest[0];
    if (!id) {
      process.stderr.write('usage: declaragent plugin info <id>\n');
      return 1;
    }
    return pluginInfo(id);
  }
  if (action === 'remove') {
    const id = rest[0];
    if (!id) {
      process.stderr.write('usage: declaragent plugin remove <id>\n');
      return 1;
    }
    return pluginRemove(id);
  }
  process.stderr.write(`unknown plugin subcommand: ${action ?? '(none)'}\n`);
  return 1;
}

async function runSkillSubcommand(action: string | undefined): Promise<number> {
  if (action === 'list') return skillList();
  process.stderr.write(`unknown skill subcommand: ${action ?? '(none)'}\n`);
  return 1;
}

async function runMcpSubcommand(
  action: string | undefined,
  rest: readonly string[],
): Promise<number> {
  if (action === 'list') return mcpList();
  if (action === 'remove') {
    const name = rest[0];
    if (!name) {
      process.stderr.write('usage: declaragent mcp remove <name>\n');
      return 1;
    }
    return mcpRemove(name);
  }
  if (action === 'approve') {
    const name = rest[0];
    if (!name) {
      process.stderr.write('usage: declaragent mcp approve <name>\n');
      return 1;
    }
    return mcpApprove(name);
  }
  if (action === 'revoke') {
    const name = rest[0];
    if (!name) {
      process.stderr.write('usage: declaragent mcp revoke <name>\n');
      return 1;
    }
    return mcpRevoke(name);
  }
  if (action === 'login') {
    const name = rest[0];
    if (!name) {
      process.stderr.write('usage: declaragent mcp login <name>\n');
      return 1;
    }
    return mcpLogin(name);
  }
  if (action === 'logout') {
    const name = rest[0];
    if (!name) {
      process.stderr.write('usage: declaragent mcp logout <name>\n');
      return 1;
    }
    return mcpLogout(name);
  }
  if (action === 'add') {
    const name = rest[0];
    if (!name) {
      process.stderr.write(
        'usage: declaragent mcp add <name> --command <cmd> [--args a,b,c] [--scope user|project|local]\n',
      );
      return 1;
    }
    let command: string | undefined;
    let argsList: string[] | undefined;
    let protocolVersion: string | undefined;
    let scope: MCPScope = 'user';
    for (let i = 1; i < rest.length; i += 1) {
      const flag = rest[i];
      const value = rest[i + 1];
      if (flag === '--command') {
        command = value;
        i += 1;
      } else if (flag === '--args') {
        argsList = parseList(value);
        i += 1;
      } else if (flag === '--protocol' || flag === '--protocol-version') {
        protocolVersion = value;
        i += 1;
      } else if (flag === '--scope') {
        if (value !== 'user' && value !== 'project' && value !== 'local') {
          process.stderr.write(`--scope must be one of user|project|local (got "${value}")\n`);
          return 1;
        }
        scope = value;
        i += 1;
      }
    }
    if (!command) {
      process.stderr.write('--command is required for `mcp add`\n');
      return 1;
    }
    return mcpAdd(
      {
        name,
        command,
        ...(argsList ? { args: argsList } : {}),
        ...(protocolVersion ? { protocolVersion } : {}),
      },
      { scope },
    );
  }
  process.stderr.write(`unknown mcp subcommand: ${action ?? '(none)'}\n`);
  return 1;
}

const subcommand = argv[0];
if (subcommand === 'plugin') {
  const code = await runPluginSubcommand(argv[1], argv.slice(2));
  process.exit(code);
}
if (subcommand === 'skill') {
  const code = await runSkillSubcommand(argv[1]);
  process.exit(code);
}
if (subcommand === 'mcp') {
  const code = await runMcpSubcommand(argv[1], argv.slice(2));
  process.exit(code);
}
if (subcommand === 'extensions') {
  const code = await extensionsList();
  process.exit(code);
}
if (subcommand === 'daemon') {
  const code = await daemonStart();
  process.exit(code);
}
if (subcommand === 'up') {
  // `declaragent up [-d] [-f <path>]` — Docker-Compose-style lifecycle.
  // Discovers fleet.yaml or agent.yaml in cwd (or -f override), brings
  // every declared source online, and persists state for `ps` / `logs`
  // / `down` to consume. `--__detached` is the sentinel the detached
  // child sees so it doesn't recursively re-spawn.
  const detach = argv.includes('-d') || argv.includes('--detach');
  const __detached = argv.includes(DETACHED_SENTINEL);
  const fIdx = argv.findIndex((a) => a === '-f' || a === '--file');
  const manifestPath = fIdx >= 0 ? argv[fIdx + 1] : undefined;
  const upArgs: Parameters<typeof up>[0] = {};
  if (manifestPath !== undefined) upArgs.manifestPath = manifestPath;
  if (detach) upArgs.detach = true;
  if (__detached) upArgs.__detached = true;
  const code = await up(upArgs);
  process.exit(code);
}
if (subcommand === 'down') {
  const code = await down();
  process.exit(code);
}
if (subcommand === 'ps') {
  const code = await listUp();
  process.exit(code);
}
if (subcommand === 'logs') {
  const positional = argv.slice(1).filter((a) => !a.startsWith('-'));
  const agentId = positional[0];
  const follow = argv.includes('-f') || argv.includes('--follow');
  const logsArgs: Parameters<typeof tailLogs>[0] = {};
  if (agentId !== undefined) logsArgs.agentId = agentId;
  if (follow) logsArgs.follow = true;
  const code = await tailLogs(logsArgs);
  process.exit(code);
}
if (subcommand === 'daemon-status') {
  const code = await daemonStatus();
  process.exit(code);
}
if (subcommand === 'daemon-reload') {
  const code = await daemonReload();
  process.exit(code);
}
if (subcommand === 'daemon-shutdown') {
  const drain = !argv.includes('--no-drain');
  const code = await daemonShutdown(drain);
  process.exit(code);
}

async function runEventsSubcommand(
  action: string | undefined,
  rest: readonly string[],
): Promise<number> {
  if (action === 'list') {
    const args: Parameters<typeof eventsList>[0] = {};
    for (let i = 0; i < rest.length; i += 1) {
      const flag = rest[i];
      const value = rest[i + 1];
      if (flag === '--kind' && value) {
        args.kind = value as EventKind;
        i += 1;
      } else if (flag === '--last' && value) {
        const n = Number.parseInt(value, 10);
        if (Number.isFinite(n) && n > 0) args.last = n;
        i += 1;
      } else if (flag === '--correlation' && value) {
        args.correlation = value;
        i += 1;
      } else if (flag === '--outcome' && value) {
        args.outcome = value as DispatchOutcome['kind'] | 'pending';
        i += 1;
      } else if (flag === '--state' && value) {
        // Slice 3 / PR 3.2 — high-level state filter. Currently only
        // `circuit-open`, which narrows to rejected events whose reason
        // is `circuit-open`.
        if (value === 'circuit-open') {
          args.state = value;
        } else {
          process.stderr.write(
            `warning: unknown --state value "${value}"; supported: circuit-open. Ignoring.\n`,
          );
        }
        i += 1;
      }
    }
    return eventsList(args);
  }
  if (action === 'show') {
    const id = rest[0];
    if (!id) {
      process.stderr.write('usage: declaragent events show <id>\n');
      return 1;
    }
    return eventsShow(id);
  }
  if (action === 'replay') {
    const id = rest[0];
    if (!id) {
      process.stderr.write('usage: declaragent events replay <id>\n');
      return 1;
    }
    return eventsReplay(id);
  }
  if (action === 'replay-range') {
    const args: Partial<Parameters<typeof eventsReplayRange>[0]> = {};
    for (let i = 0; i < rest.length; i += 1) {
      const flag = rest[i];
      const value = rest[i + 1];
      if (flag === '--source' && value) {
        args.source = value;
        i += 1;
      } else if (flag === '--from' && value) {
        const n = Number.parseInt(value, 10);
        if (Number.isFinite(n)) args.from = n;
        i += 1;
      } else if (flag === '--to' && value) {
        const n = Number.parseInt(value, 10);
        if (Number.isFinite(n)) args.to = n;
        i += 1;
      } else if (flag === '--limit' && value) {
        const n = Number.parseInt(value, 10);
        if (Number.isFinite(n) && n > 0) args.limit = n;
        i += 1;
      } else if (flag === '--filter' && value) {
        args.filter = value;
        i += 1;
      } else if (flag === '--no-dispatch') {
        args.dispatch = false;
      }
    }
    if (!args.source || args.from === undefined) {
      process.stderr.write(
        'usage: declaragent events replay-range --source <id> --from <ms> [--to <ms>] [--limit <n>] [--filter <expr>] [--no-dispatch]\n',
      );
      return 1;
    }
    return eventsReplayRange(args as Parameters<typeof eventsReplayRange>[0]);
  }
  process.stderr.write(`unknown events subcommand: ${action ?? '(none)'}\n`);
  return 1;
}

async function runDlqSubcommand(
  action: string | undefined,
  rest: readonly string[],
): Promise<number> {
  // `--kind` picks the DLQ surface. Default is `source` for backwards
  // compat with 0.5.x behaviour. `dispatch` (Slice 5 / PR 5.2) routes
  // to the SQLite-backed `rejected_events` table — no daemon socket.
  let kind: 'source' | 'dispatch' = 'source';
  let source: string | undefined;
  let reason: string | undefined;
  let minAttempts: number | undefined;
  let agent: string | undefined;
  const positional: string[] = [];
  let since: number | undefined;
  let limit: number | undefined;
  for (let i = 0; i < rest.length; i += 1) {
    const arg = rest[i];
    const value = rest[i + 1];
    if (arg === '--kind' && value) {
      if (value === 'dispatch' || value === 'source') kind = value;
      else {
        process.stderr.write(
          `warning: unknown --kind value "${value}"; supported: source, dispatch. Ignoring.\n`,
        );
      }
      i += 1;
    } else if (arg === '--source' && value) {
      source = value;
      i += 1;
    } else if (arg === '--agent' && value) {
      agent = value;
      i += 1;
    } else if (arg === '--reason' && value) {
      reason = value;
      i += 1;
    } else if (arg === '--min-attempts' && value) {
      const n = Number.parseInt(value, 10);
      if (Number.isFinite(n) && n > 0) minAttempts = n;
      i += 1;
    } else if (arg === '--since' && value) {
      const n = Number.parseInt(value, 10);
      if (Number.isFinite(n)) since = n;
      i += 1;
    } else if (arg === '--limit' && value) {
      const n = Number.parseInt(value, 10);
      if (Number.isFinite(n) && n > 0) limit = n;
      i += 1;
    } else if (arg !== undefined && !arg.startsWith('--')) {
      positional.push(arg);
    }
  }

  // Dispatch DLQ (Slice 5 / PR 5.2): direct SQLite reads.
  if (kind === 'dispatch') {
    if (action === 'list') {
      return dlqDispatchList({
        ...(reason !== undefined && { reason }),
        ...(minAttempts !== undefined && { minAttempts }),
        ...(since !== undefined && { sinceMs: since }),
        ...(limit !== undefined && { limit }),
      });
    }
    if (action === 'show') {
      const entryId = positional[0];
      if (!entryId) {
        process.stderr.write('usage: declaragent dlq show --kind dispatch <eventId>\n');
        return 1;
      }
      return dlqDispatchShow(entryId);
    }
    if (action === 'drop') {
      const entryId = positional[0];
      if (!entryId) {
        process.stderr.write('usage: declaragent dlq drop --kind dispatch <eventId>\n');
        return 1;
      }
      return dlqDispatchDrop(entryId);
    }
    if (action === 'requeue' || action === 'redrive') {
      const entryId = positional[0];
      if (!entryId) {
        process.stderr.write(
          'usage: declaragent dlq requeue --kind dispatch <eventId> [--agent <id>]\n',
        );
        return 1;
      }
      return dlqDispatchRequeue({
        eventId: entryId,
        ...(agent !== undefined && { agentId: agent }),
      });
    }
    process.stderr.write(
      `unknown dlq --kind dispatch subcommand: ${action ?? '(none)'}. Supported: list, show, drop, requeue.\n`,
    );
    return 1;
  }

  // Source DLQ (pre-existing path, IPC through the daemon socket).
  if (!source) {
    process.stderr.write(
      `usage: declaragent dlq ${action ?? '<subcommand>'} --source <id> [args]\n`,
    );
    return 1;
  }
  if (action === 'list') {
    return dlqList({
      source,
      ...(since !== undefined && { since }),
      ...(limit !== undefined && { limit }),
    });
  }
  if (action === 'show') {
    const entryId = positional[0];
    if (!entryId) {
      process.stderr.write('usage: declaragent dlq show --source <id> <entryId>\n');
      return 1;
    }
    return dlqShow(source, entryId);
  }
  if (action === 'redrive') {
    const entryId = positional[0];
    if (!entryId) {
      process.stderr.write('usage: declaragent dlq redrive --source <id> <entryId>\n');
      return 1;
    }
    return dlqRedrive(source, entryId);
  }
  process.stderr.write(`unknown dlq subcommand: ${action ?? '(none)'}\n`);
  return 1;
}

async function runSourceSubcommand(
  action: string | undefined,
  rest: readonly string[],
): Promise<number> {
  if (action === 'list') return sourceList();
  if (action === 'add') {
    const type = rest[0];
    const id = rest[1];
    if (!type || !id) {
      process.stderr.write(
        'usage: declaragent source add <type> <id> --config <json> | --config-file <path>\n',
      );
      return 1;
    }
    let configJson: string | undefined;
    let configFile: string | undefined;
    for (let i = 2; i < rest.length; i += 1) {
      const flag = rest[i];
      const value = rest[i + 1];
      if (flag === '--config' && value) {
        configJson = value;
        i += 1;
      } else if (flag === '--config-file' && value) {
        configFile = value;
        i += 1;
      }
    }
    return sourceAdd({
      type,
      id,
      ...(configJson !== undefined && { configJson }),
      ...(configFile !== undefined && { configFile }),
    });
  }
  if (action === 'remove') {
    const key = rest[0];
    if (!key) {
      process.stderr.write('usage: declaragent source remove <type:id | id>\n');
      return 1;
    }
    return sourceRemove(key);
  }
  process.stderr.write(`unknown source subcommand: ${action ?? '(none)'}\n`);
  return 1;
}

async function runMailboxSubcommand(
  action: string | undefined,
  rest: readonly string[],
): Promise<number> {
  const agent = rest[0];
  if (action === 'depth') {
    if (!agent) {
      process.stderr.write('usage: declaragent mailbox depth <agent-id>\n');
      return 1;
    }
    return mailboxDepth(agent);
  }
  if (action === 'drain') {
    if (!agent) {
      process.stderr.write('usage: declaragent mailbox drain <agent-id>\n');
      return 1;
    }
    return mailboxDrain(agent);
  }
  process.stderr.write(`unknown mailbox subcommand: ${action ?? '(none)'}\n`);
  return 1;
}

function flagSet(rest: readonly string[], ...flags: string[]): boolean {
  return rest.some((arg) => flags.includes(arg));
}

function flagValue(rest: readonly string[], ...flags: string[]): string | undefined {
  for (let i = 0; i < rest.length; i += 1) {
    const arg = rest[i];
    if (arg && flags.includes(arg)) return rest[i + 1];
  }
  return undefined;
}

function firstPositional(rest: readonly string[]): string | undefined {
  return rest.find((arg) => arg !== undefined && !arg.startsWith('--'));
}

async function runFleetSubcommand(
  action: string | undefined,
  rest: readonly string[],
): Promise<number> {
  const json = flagSet(rest, '--json');
  if (action === 'list') {
    return fleetList({ json });
  }
  if (action === 'validate') {
    return fleetValidate({ json });
  }
  if (action === 'capabilities') {
    return fleetCapabilities({ json });
  }
  if (action === 'new' || action === 'init') {
    const name = firstPositional(rest);
    if (!name) {
      process.stderr.write('usage: declaragent fleet new <name> [--out <dir>] [--force]\n');
      return 1;
    }
    const out = flagValue(rest, '--out');
    const force = flagSet(rest, '--force');
    return fleetInit({
      name,
      ...(out !== undefined && { out }),
      ...(force && { force: true }),
    });
  }
  if (action === 'add') {
    const template = flagValue(rest, '--template');
    const path = flagValue(rest, '--path');
    const id = flagValue(rest, '--id');
    const force = flagSet(rest, '--force');
    return fleetAdd({
      ...(template !== undefined && { template }),
      ...(path !== undefined && { path }),
      ...(id !== undefined && { id }),
      ...(force && { force: true }),
    });
  }
  if (action === 'run') {
    // `--agent` may repeat: `fleet run --agent a --agent b`.
    const agents: string[] = [];
    for (let i = 0; i < rest.length; i += 1) {
      if (rest[i] === '--agent') {
        const v = rest[i + 1];
        if (v) agents.push(v);
        i += 1;
      }
    }
    return fleetRun(agents.length > 0 ? { agents } : {});
  }
  if (action === 'promote') {
    const path = firstPositional(rest);
    if (!path) {
      process.stderr.write(
        'usage: declaragent fleet promote <path> [--apply] [--id <id>] [--force]\n',
      );
      return 1;
    }
    const apply = flagSet(rest, '--apply');
    const dryRun = flagSet(rest, '--dry-run');
    const force = flagSet(rest, '--force');
    const id = flagValue(rest, '--id');
    return fleetPromote({
      path,
      ...(apply && { apply: true }),
      ...(dryRun && { dryRun: true }),
      ...(force && { force: true }),
      ...(id !== undefined && { id }),
    });
  }
  if (action === 'demote') {
    const id = firstPositional(rest);
    const force = flagSet(rest, '--force');
    return fleetDemote({
      ...(id !== undefined && { id }),
      ...(force && { force: true }),
    });
  }
  if (action === 'deploy') {
    const target = flagValue(rest, '--target');
    const agents: string[] = [];
    for (let i = 0; i < rest.length; i += 1) {
      if (rest[i] === '--agent') {
        const v = rest[i + 1];
        if (v) agents.push(v);
        i += 1;
      }
    }
    const strategyRaw = flagValue(rest, '--strategy');
    const strategy =
      strategyRaw === 'rolling' ||
      strategyRaw === 'all-or-nothing' ||
      strategyRaw === 'per-agent' ||
      strategyRaw === 'canary'
        ? strategyRaw
        : undefined;
    const dryRun = flagSet(rest, '--dry-run');
    const rollback = flagSet(rest, '--rollback');
    const targetConfigPath = flagValue(rest, '--target-config');
    // Canary soak override. `--canary` is a convenience flag equivalent
    // to `--strategy canary`; `--canary-wait-ms <n>` overrides the
    // default 60s soak. Both composable so operators can say
    // `--canary --canary-wait-ms 120000`.
    const canaryFlag = flagSet(rest, '--canary');
    const canaryWaitMsRaw = flagValue(rest, '--canary-wait-ms');
    const canaryWaitMs =
      canaryWaitMsRaw !== undefined ? Number.parseInt(canaryWaitMsRaw, 10) : undefined;
    const resolvedStrategy = canaryFlag ? 'canary' : strategy;
    return fleetDeploy({
      ...(target !== undefined && { target }),
      ...(agents.length > 0 && { agents }),
      ...(resolvedStrategy !== undefined && { strategy: resolvedStrategy }),
      ...(dryRun && { dryRun: true }),
      ...(rollback && { rollback: true }),
      ...(targetConfigPath !== undefined && { targetConfigPath }),
      ...(Number.isFinite(canaryWaitMs) && { canaryWaitMs: canaryWaitMs as number }),
      json,
    });
  }
  if (action === 'graph') {
    const fmtRaw = flagValue(rest, '--format');
    const format: GraphFormat | undefined =
      fmtRaw === 'mermaid' || fmtRaw === 'dot' || fmtRaw === 'json' ? fmtRaw : undefined;
    return fleetGraph(format !== undefined ? { format } : {});
  }
  if (action === 'render') {
    const target = flagValue(rest, '--target');
    const format = flagValue(rest, '--format');
    const out = flagValue(rest, '--out', '-o');
    const image = flagValue(rest, '--image');
    const namespace = flagValue(rest, '--namespace');
    const replicasRaw = flagValue(rest, '--replicas');
    const replicas = replicasRaw !== undefined ? Number.parseInt(replicasRaw, 10) : undefined;
    // ServiceMonitor is emitted by default (assumes Prometheus
    // Operator is installed). `--no-servicemonitor` / `--no-service-monitor`
    // opts out. `--with-servicemonitor` is the explicit positive form
    // — currently a no-op (same as the default) but documented for
    // symmetry so operators can be explicit in scripts (#31, 0.7.3).
    const withServiceMonitor = flagSet(rest, '--with-servicemonitor', '--with-service-monitor');
    const noServiceMonitor =
      flagSet(rest, '--no-servicemonitor', '--no-service-monitor') && !withServiceMonitor;
    // Config-split opts INTO the split-ConfigMap rendering (#32, 0.7.5).
    // Default-off preserves today's monolithic ConfigMap; a future
    // minor may flip the default once the ecosystem absorbs it.
    const configSplit = flagSet(rest, '--config-split');
    return fleetRender({
      ...(target !== undefined && { target }),
      ...(format !== undefined && { format }),
      ...(out !== undefined && { out }),
      ...(image !== undefined && { image }),
      ...(namespace !== undefined && { namespace }),
      ...(replicas !== undefined && Number.isFinite(replicas) && replicas > 0 && { replicas }),
      ...(noServiceMonitor && { noServiceMonitor: true }),
      ...(configSplit && { configSplit: true }),
      ...(json && { json: true }),
    });
  }
  if (action === 'peers') {
    const verify = flagSet(rest, '--verify');
    return fleetPeers({
      ...(verify && { verify: true }),
      ...(json && { json: true }),
    });
  }
  if (action === 'status') {
    const history = flagSet(rest, '--history');
    const limitRaw = flagValue(rest, '--limit');
    const historyLimit = limitRaw !== undefined ? Number.parseInt(limitRaw, 10) : undefined;
    return fleetStatus({
      ...(history && { history: true }),
      ...(Number.isFinite(historyLimit) && { historyLimit: historyLimit as number }),
      ...(json && { json: true }),
    });
  }
  if (action === 'audit-rpc') {
    const suggestEnable = flagSet(rest, '--suggest-enable');
    const strict = flagSet(rest, '--strict');
    return fleetAuditRpc({
      ...(suggestEnable && { suggestEnable: true }),
      ...(strict && { strict: true }),
      ...(json && { json: true }),
    });
  }
  // Cross-host fan-out verbs (CONTROL_PLANE_PLAN.md Slice 3, #50).
  if (action === 'ps') {
    const host = flagValue(rest, '--host');
    return fleetPs({
      ...(host !== undefined && { host }),
      ...(json && { json: true }),
    });
  }
  if (action === 'events') {
    const host = flagValue(rest, '--host');
    const kind = flagValue(rest, '--kind');
    const sinceRaw = flagValue(rest, '--since');
    const since = sinceRaw !== undefined ? Number.parseInt(sinceRaw, 10) : undefined;
    const stateRaw = flagValue(rest, '--state');
    const state: 'circuit-open' | undefined =
      stateRaw === 'circuit-open' ? 'circuit-open' : undefined;
    const outcome = flagValue(rest, '--outcome');
    const correlation = flagValue(rest, '--correlation');
    const limitRaw = flagValue(rest, '--limit');
    const limit = limitRaw !== undefined ? Number.parseInt(limitRaw, 10) : undefined;
    const all = flagSet(rest, '--all');
    return fleetEventsList({
      ...(host !== undefined && { host }),
      ...(kind !== undefined && { kind }),
      ...(since !== undefined && Number.isFinite(since) && { since: since as number }),
      ...(state !== undefined && { state }),
      ...(outcome !== undefined && { outcome }),
      ...(correlation !== undefined && { correlation }),
      ...(limit !== undefined && Number.isFinite(limit) && { limit: limit as number }),
      ...(all && { all: true }),
      ...(json && { json: true }),
    });
  }
  if (action === 'dlq') {
    const host = flagValue(rest, '--host');
    const reason = flagValue(rest, '--reason');
    const minAttemptsRaw = flagValue(rest, '--min-attempts');
    const minAttempts =
      minAttemptsRaw !== undefined ? Number.parseInt(minAttemptsRaw, 10) : undefined;
    const sinceRaw = flagValue(rest, '--since');
    const since = sinceRaw !== undefined ? Number.parseInt(sinceRaw, 10) : undefined;
    const limitRaw = flagValue(rest, '--limit');
    const limit = limitRaw !== undefined ? Number.parseInt(limitRaw, 10) : undefined;
    const all = flagSet(rest, '--all');
    return fleetDlqList({
      kind: 'dispatch',
      ...(host !== undefined && { host }),
      ...(reason !== undefined && { reason }),
      ...(minAttempts !== undefined &&
        Number.isFinite(minAttempts) && { minAttempts: minAttempts as number }),
      ...(since !== undefined && Number.isFinite(since) && { since: since as number }),
      ...(limit !== undefined && Number.isFinite(limit) && { limit: limit as number }),
      ...(all && { all: true }),
      ...(json && { json: true }),
    });
  }
  if (action === 'logs') {
    const host = flagValue(rest, '--host');
    const agent = flagValue(rest, '--agent');
    const follow = flagSet(rest, '-f', '--follow');
    const maxLinesRaw = flagValue(rest, '--max-lines');
    const maxLinesPerHost =
      maxLinesRaw !== undefined ? Number.parseInt(maxLinesRaw, 10) : undefined;
    return fleetLogs({
      ...(host !== undefined && { host }),
      ...(agent !== undefined && { agent }),
      ...(follow && { follow: true }),
      ...(maxLinesPerHost !== undefined &&
        Number.isFinite(maxLinesPerHost) && {
          maxLinesPerHost: maxLinesPerHost as number,
        }),
      ...(json && { json: true }),
    });
  }
  process.stderr.write(`unknown fleet subcommand: ${action ?? '(none)'}\n`);
  process.stderr.write(
    'usage: declaragent fleet <new|add|run|promote|demote|deploy|render|graph|peers|status|list|validate|capabilities|audit-rpc|ps|events|dlq|logs> [options]\n',
  );
  return 1;
}

async function runTenantsSubcommand(
  action: string | undefined,
  rest: readonly string[],
): Promise<number> {
  const json = flagSet(rest, '--json');
  if (action === 'list') {
    return tenantsList({ json });
  }
  if (action === 'diff') {
    return tenantsDiff({ json });
  }
  if (action === 'show') {
    const id = firstPositional(rest);
    if (!id) {
      process.stderr.write('usage: declaragent tenants show <id> [--json]\n');
      return 1;
    }
    return tenantsShow({ id, json });
  }
  process.stderr.write(`unknown tenants subcommand: ${action ?? '(none)'}\n`);
  return 1;
}

async function runAuditSubcommand(
  action: string | undefined,
  rest: readonly string[],
): Promise<number> {
  const json = flagSet(rest, '--json');
  if (action === 'query') {
    const tenant = flagValue(rest, '--tenant');
    const kind = flagValue(rest, '--kind');
    const sinceRaw = flagValue(rest, '--since');
    const untilRaw = flagValue(rest, '--until');
    const limitRaw = flagValue(rest, '--limit');
    const since = sinceRaw !== undefined ? Number.parseInt(sinceRaw, 10) : undefined;
    const until = untilRaw !== undefined ? Number.parseInt(untilRaw, 10) : undefined;
    const limit = limitRaw !== undefined ? Number.parseInt(limitRaw, 10) : undefined;
    return auditQuery({
      ...(tenant !== undefined && { tenant }),
      ...(kind !== undefined && { kind: kind as NonNullable<AuditQueryArgs['kind']> }),
      ...(since !== undefined && Number.isFinite(since) && { since }),
      ...(until !== undefined && Number.isFinite(until) && { until }),
      ...(limit !== undefined && Number.isFinite(limit) && limit > 0 && { limit }),
      json,
    });
  }
  if (action === 'verify') {
    const tenant = flagValue(rest, '--tenant');
    return auditVerify({ ...(tenant !== undefined && { tenant }), json });
  }
  if (action === 'erase') {
    const user = flagValue(rest, '--user');
    const reason = flagValue(rest, '--reason');
    if (!user) {
      process.stderr.write(
        'usage: declaragent audit erase --user <platformUserId> [--reason R] [--json]\n',
      );
      return 1;
    }
    return auditErase({
      user,
      ...(reason !== undefined && { reason }),
      json,
    });
  }
  if (action === 'prune') {
    const tenant = flagValue(rest, '--tenant');
    const retentionRaw = flagValue(rest, '--retention-days');
    const retentionDays =
      retentionRaw !== undefined ? Number.parseInt(retentionRaw, 10) : Number.NaN;
    if (!tenant || !Number.isFinite(retentionDays) || retentionDays <= 0) {
      process.stderr.write(
        'usage: declaragent audit prune --tenant <id> --retention-days <N> [--json]\n',
      );
      return 1;
    }
    return auditPrune({ tenant, retentionDays, json });
  }
  process.stderr.write(`unknown audit subcommand: ${action ?? '(none)'}\n`);
  return 1;
}

function printInitHelp(): void {
  process.stdout.write(`declaragent init — first-run wizard

Usage:
  declaragent init [--out <dir>] [--force] [--multi-tenant]
                   [--template <name>] [--provider <id>] [--tenant-id <id>]
                   [--skip-verify]

Flags:
  --out <dir>          Target directory (default: ./)
  --force              Overwrite an existing agent.yaml
  --multi-tenant       Scaffold tenants.yaml too + prompt for tenant id
  --template <name>    Non-interactive template pick
                       (concierge | oncall-escalator | pr-review |
                        kafka-pipeline | multi-tenant-starter)
  --provider <id>      Non-interactive provider pick (matches \`auth login <id>\`)
  --tenant-id <id>     Tenant id used when --multi-tenant is set
  --skip-verify        Skip the one-shot LLM verify call
`);
}

async function runInitSubcommand(rest: readonly string[]): Promise<number> {
  if (rest.includes('--help') || rest.includes('-h')) {
    printInitHelp();
    return 0;
  }
  // Fleet scaffold path: `declaragent init --fleet <name>` routes into
  // `fleetInit` instead of the single-agent wizard. Keeps the two flows
  // discoverable from one top-level `init` verb.
  const fleetName = flagValue(rest, '--fleet');
  if (fleetName !== undefined) {
    const out = flagValue(rest, '--out', '-o') ?? firstPositional(rest);
    const force = flagSet(rest, '--force');
    return fleetInit({
      name: fleetName,
      ...(out !== undefined && { out }),
      ...(force && { force: true }),
    });
  }
  // Resolution order for the output directory:
  //   1. --out / -o flag
  //   2. first positional arg (e.g. `declaragent init test-agent` → ./test-agent)
  //   3. current directory
  const outDir = flagValue(rest, '--out', '-o') ?? firstPositional(rest) ?? './';
  const force = flagSet(rest, '--force');
  const multiTenant = flagSet(rest, '--multi-tenant');
  const template = flagValue(rest, '--template');
  const provider = flagValue(rest, '--provider');
  const tenantId = flagValue(rest, '--tenant-id');
  const skipVerify = flagSet(rest, '--skip-verify');

  const opts: InitOptions = {
    outDir,
    force,
    multiTenant,
    ...(template !== undefined && { template }),
    ...(provider !== undefined && { provider }),
    ...(tenantId !== undefined && { tenantId }),
    ...(skipVerify && { skipVerify: true }),
  };
  return runInit(opts, { launchInteractive: launchInitWizard });
}

/**
 * Render the Ink wizard, wait for the user to pick a template (and
 * optionally a tenant id), then re-enter `runInit` with the filled-in
 * fields. Falls back to a helpful error when stdin isn't a TTY (CI,
 * piped shells) since the wizard can't read keystrokes there.
 */
async function launchInitWizard(opts: InitOptions): Promise<number> {
  if (!process.stdin.isTTY) {
    process.stderr.write(
      '✗ interactive wizard needs a TTY. Re-run with --template <name> to pick non-interactively.\n',
    );
    process.stderr.write(
      '  Available: concierge, oncall-escalator, pr-review, kafka-pipeline, multi-tenant-starter\n',
    );
    return 1;
  }
  const result: WizardResult = await new Promise((resolve) => {
    const instance = render(
      <InitWizard
        initialMultiTenant={opts.multiTenant}
        onDone={(r) => {
          instance.unmount();
          resolve(r);
        }}
      />,
    );
  });
  const next: InitOptions = {
    ...opts,
    template: result.template,
    ...(result.tenantId !== undefined && { tenantId: result.tenantId, multiTenant: true }),
  };
  // Second call: template is now set; `runInit` takes the non-interactive path.
  return runInit(next);
}

async function runDeploySubcommand(
  action: string | undefined,
  rest: readonly string[],
): Promise<number> {
  if (action !== 'gcp-cloud-run') {
    process.stderr.write(
      'usage: declaragent deploy gcp-cloud-run [--out <dir>] [--force] [--project <id>] [--region <r>] [--service <name>] [--cpu <n>] [--memory-mib <n>] [--min-instances <n>] [--verify] [--json]\n',
    );
    return 1;
  }
  const json = flagSet(rest, '--json');
  const force = flagSet(rest, '--force');
  const verify = flagSet(rest, '--verify');
  const outDir = flagValue(rest, '--out', '-o');
  const project = flagValue(rest, '--project');
  const region = flagValue(rest, '--region');
  const serviceName = flagValue(rest, '--service');
  const agentYamlPath = flagValue(rest, '--agent-yaml');
  const cpuRaw = flagValue(rest, '--cpu');
  const memRaw = flagValue(rest, '--memory-mib');
  const minRaw = flagValue(rest, '--min-instances');
  const cpu = cpuRaw !== undefined ? Number.parseInt(cpuRaw, 10) : undefined;
  const memoryMib = memRaw !== undefined ? Number.parseInt(memRaw, 10) : undefined;
  const minInstances = minRaw !== undefined ? Number.parseInt(minRaw, 10) : undefined;

  if (verify) {
    return verifyGcpCloudRunDeploy({
      ...(agentYamlPath !== undefined && { agentYamlPath }),
      ...(project !== undefined && { project }),
      ...(region !== undefined && { region }),
      ...(serviceName !== undefined && { serviceName }),
      json,
    });
  }
  return deployGcpCloudRun({
    ...(agentYamlPath !== undefined && { agentYamlPath }),
    ...(outDir !== undefined && { outDir }),
    force,
    ...(project !== undefined && { project }),
    ...(region !== undefined && { region }),
    ...(serviceName !== undefined && { serviceName }),
    ...(cpu !== undefined && Number.isFinite(cpu) && cpu > 0 && { cpu }),
    ...(memoryMib !== undefined && Number.isFinite(memoryMib) && memoryMib > 0 && { memoryMib }),
    ...(minInstances !== undefined && Number.isFinite(minInstances) && { minInstances }),
    json,
  });
}

async function runMigrateSubcommand(rest: readonly string[]): Promise<number> {
  if (rest.includes('--help') || rest.includes('-h')) {
    process.stdout.write(
      `declaragent migrate — walk pre-v1.0 configs forward.

Usage:
  declaragent migrate [--config-dir <path>] [--apply] [--json]

Flags:
  --config-dir <path>   Directory to migrate (default: ~/.declaragent).
  --apply               Write changes. Omit for a dry-run report.
  --json                Emit a single JSON report instead of text.
`,
    );
    return 0;
  }
  const configDirArg = flagValue(rest, '--config-dir');
  const apply = flagSet(rest, '--apply');
  const json = flagSet(rest, '--json');
  return migrateConfig({
    ...(configDirArg !== undefined && { configDir: configDirArg }),
    apply,
    json,
  });
}

async function runSecretsSubcommand(
  action: string | undefined,
  rest: readonly string[],
): Promise<number> {
  const json = flagSet(rest, '--json');
  if (action === 'list') {
    const provider = flagValue(rest, '--provider');
    return secretsList({ ...(provider !== undefined && { provider }), json });
  }
  if (action === 'describe') {
    const ref = firstPositional(rest);
    if (!ref) {
      process.stderr.write('usage: declaragent secrets describe <ref> [--json]\n');
      return 1;
    }
    return secretsDescribe({ ref, json });
  }
  if (action === 'rotate') {
    const ref = firstPositional(rest);
    const tenant = flagValue(rest, '--tenant');
    const reason = flagValue(rest, '--reason');
    if (!ref) {
      process.stderr.write(
        'usage: declaragent secrets rotate <ref> [--tenant X] [--reason R] [--json]\n',
      );
      return 1;
    }
    return secretsRotate({
      ref,
      ...(tenant !== undefined && { tenant }),
      ...(reason !== undefined && { reason }),
      json,
    });
  }
  process.stderr.write(`unknown secrets subcommand: ${action ?? '(none)'}\n`);
  return 1;
}

if (subcommand === 'events') {
  const code = await runEventsSubcommand(argv[1], argv.slice(2));
  process.exit(code);
}
if (subcommand === 'dlq') {
  const code = await runDlqSubcommand(argv[1], argv.slice(2));
  process.exit(code);
}
if (subcommand === 'events-config') {
  const action = argv[1];
  if (action === 'validate') {
    const path = argv[2];
    const code = await eventsConfigValidate(path ? { path } : {});
    process.exit(code);
  }
  process.stderr.write(`unknown events-config subcommand: ${action ?? '(none)'}\n`);
  process.exit(1);
}
if (subcommand === 'source') {
  const code = await runSourceSubcommand(argv[1], argv.slice(2));
  process.exit(code);
}
if (subcommand === 'source-adapters') {
  const action = argv[1];
  if (action === 'list') {
    const code = await sourceAdaptersList();
    process.exit(code);
  }
  process.stderr.write(`unknown source-adapters subcommand: ${action ?? '(none)'}\n`);
  process.exit(1);
}
if (subcommand === 'mailbox') {
  const code = await runMailboxSubcommand(argv[1], argv.slice(2));
  process.exit(code);
}
if (subcommand === 'fleet') {
  const code = await runFleetSubcommand(argv[1], argv.slice(2));
  process.exit(code);
}
if (subcommand === 'capabilities') {
  const action = argv[1];
  if (action === 'gen') {
    const rest = argv.slice(2);
    const peer = flagValue(rest, '--peer');
    const caps = flagValue(rest, '--capabilities');
    const out = flagValue(rest, '--out', '-o');
    const json = flagSet(rest, '--json');
    const code = await capabilitiesGen({
      ...(peer !== undefined && { peer }),
      ...(caps !== undefined && { capabilities: caps }),
      ...(out !== undefined && { out }),
      ...(json && { json: true }),
    });
    process.exit(code);
  }
  process.stderr.write(`unknown capabilities subcommand: ${action ?? '(none)'}\n`);
  process.stderr.write('usage: declaragent capabilities gen --peer <id> [--out <dir>]\n');
  process.exit(1);
}
if (subcommand === 'tenants') {
  const code = await runTenantsSubcommand(argv[1], argv.slice(2));
  process.exit(code);
}
if (subcommand === 'audit') {
  const code = await runAuditSubcommand(argv[1], argv.slice(2));
  process.exit(code);
}
if (subcommand === 'secrets') {
  const code = await runSecretsSubcommand(argv[1], argv.slice(2));
  process.exit(code);
}
if (subcommand === 'init') {
  const code = await runInitSubcommand(argv.slice(1));
  process.exit(code);
}
if (subcommand === 'deploy') {
  const code = await runDeploySubcommand(argv[1], argv.slice(2));
  process.exit(code);
}
if (subcommand === 'migrate') {
  const code = await runMigrateSubcommand(argv.slice(1));
  process.exit(code);
}
if (subcommand === 'auth') {
  const action = argv[1];
  if (action === 'status') {
    runAuthStatus();
    process.exit(0);
  }
  if (action === 'logout') {
    runAuthLogout();
    process.exit(0);
  }
  if (action === 'login') {
    const providerArg = argv[2];
    let preset: ProviderPreset | undefined;
    if (providerArg && !providerArg.startsWith('--')) {
      preset = getPreset(providerArg);
      if (!preset) {
        process.stderr.write(
          `unknown provider: ${providerArg}\nSupported: ${listPresets()
            .map((p) => p.id)
            .join(', ')}\n`,
        );
        process.exit(1);
      }
    }
    if (!preset) {
      // Picker — show all presets, user arrows + selects.
      let chosen: ProviderPreset | undefined;
      await runInkFlow(
        <AuthProviderPicker
          onSelect={(p) => {
            chosen = p;
          }}
        />,
      );
      if (!chosen) {
        process.stderr.write('cancelled.\n');
        process.exit(1);
      }
      preset = chosen;
    }
    await runProviderAuth(preset);
    if (resolveCredentials()) {
      process.stdout.write('\nStarting REPL…\n\n');
      launchRepl();
    } else {
      process.stderr.write(
        '\nauth did not complete — no credentials saved. Re-run `auth login` to retry.\n',
      );
      process.exit(1);
    }
  } else {
    process.stderr.write(`unknown auth subcommand: ${action ?? '(none)'}\n`);
    printHelp();
    process.exit(1);
  }
} else {
  if (!resolveCredentials()) {
    process.stderr.write('no credentials. Run `declaragent auth login` to choose a provider.\n');
    process.exit(1);
  }
  launchRepl();
}
