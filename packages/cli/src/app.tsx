import { existsSync, readFileSync } from 'node:fs';
import {
  Agent,
  type AgentSpec,
  Bash,
  Edit,
  type Engine,
  GlobTool,
  Grep,
  type Message,
  type PendingToolCall,
  type PermissionDecision,
  type PermissionMode,
  Read,
  type SessionHandle,
  type SqliteSessionStore,
  type Tool,
  Write,
  createAnthropicProvider,
  createEngine,
  createOpenAICompatProvider,
  createPermissionGate,
  createSqliteSessionStore,
} from '@declaragent/core';
import type { LLMProvider } from '@declaragent/core';
import { createSqliteAuditSink } from '@declaragent/core';
import type { TenantAuditSink } from '@declaragent/core';
import { Box, Static, Text, useApp, useInput } from 'ink';
import TextInput from 'ink-text-input';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { loadConfig, rememberModel, resolveCredentials } from './auth.js';
import { Banner } from './banner.js';
import {
  DEFAULT_DEPLOY_DENY_RULES,
  ProposalRegistry,
  formatLeakWarning,
  getBuilderTools,
  redactSecrets,
  renderHistory,
  renderProposal,
  resolveScopeRootSync,
  runGitRaw,
  runHistory,
  runUndo,
} from './builder/index.js';
import type { Proposal, ProposalEvent } from './builder/index.js';
import { fleetGraph } from './fleet-graph-cli.js';
import { appendHistory, loadHistory } from './history.js';
import {
  TEMPLATE_NAMES,
  type TemplateName,
  isTemplateName,
  unpackTemplate,
} from './init-template-unpacker.js';
import { defaultModelFor, knownModelsFor } from './known-models.js';
import { fetchOpenAICompatModels } from './openai-compat-models.js';
import { fetchOpenRouterModels, summarizeModel } from './openrouter-models.js';
import { DECLARAGENT_REFERRER, DECLARAGENT_TITLE } from './openrouter-oauth.js';
import { auditDbPath, memoryFilePath, sessionsDbPath } from './paths.js';
import { getPreset } from './providers-registry.js';
import { SLASH_COMMANDS, type SlashCommand, parseSlash } from './slash-commands.js';

const BUILTIN_TOOLS: Tool[] = [Read, Write, Edit, GlobTool, Grep, Bash, Agent];

type Line =
  | { kind: 'user'; text: string }
  | { kind: 'assistant'; text: string }
  | { kind: 'tool'; toolName: string; status: 'started' | 'ok' | 'error'; detail?: string }
  | { kind: 'system'; text: string }
  | { kind: 'error'; text: string }
  | { kind: 'banner'; providerId: string; model: string; mode: string; source?: string };

interface AppProps {
  initialMode?: PermissionMode;
  model?: string;
}

const SYSTEM_PROMPT = `You are the Declaragent REPL — an agent whose job is to help the user
design, build, configure, and operate other declaragent agents.

You are built on the same \`@declaragent/core\` runtime the user will ship
to production. Same tools, same permission gate, same audit chain. When
you generate an agent, you're generating a sibling of yourself.

# Mental model

- An **agent** is a directory containing an \`agent.yaml\` (identity,
  model, tools, skills, plugins, sources, channels, permissions) plus a
  \`skills/\` folder. No code required in the happy path.
- A **fleet** is a directory with a \`fleet.yaml\` listing N agents under
  \`agents/\`, sharing a peer table, tenants, secrets, and deploys. Use
  fleets when multiple agents talk to each other or roll out together.
- **Capabilities** are composable: tools (built-in or MCP), skills
  (markdown prompts), plugins (npm), event sources (cron, webhook,
  file-watch, kafka, nats, sqs, amqp, mqtt), channels (slack,
  telegram, discord, whatsapp), tenancy, secrets (vault/aws-sm/gcp-sm/k8s),
  audit, observability (prometheus, otel), deploy (gcp-cloud-run).

# Starter templates

Single-agent:
  - \`concierge\`           — Slack Q&A over this repo (Socket Mode + Read/Grep/Glob)
  - \`oncall-escalator\`    — Alertmanager webhook → Claude triage → Slack DM
  - \`pr-review\`           — GitHub webhook → diff review → inline comments
  - \`kafka-pipeline\`      — Kafka source → enrichment → downstream topic
  - \`multi-tenant-starter\` — per-tenant quotas + extensions + residency

Fleet + agent-rpc:
  - \`rpc-client\` + \`rpc-server\`  — paired agents exchanging typed requests
  - \`fleet-starter\`                — two-agent fleet manifest

Pick a template when the user's ask fits one; otherwise start from
concierge + extend.

# Your tools + the CLI

You have \`Read\`, \`Write\`, \`Edit\`, \`Glob\`, \`Grep\`, \`Bash\`, and \`Agent\`
(spawn subagents). Through \`Bash\` you can invoke the full declaragent
CLI. The common verbs:

  Scaffold / compose
    declaragent init <name> --template <t> --provider <id>
    declaragent init --fleet <name>
    declaragent fleet add --template <t> [--id <id>]
    declaragent plugin install <pkg>
    declaragent mcp add <name> --command <cmd> [--args a,b,c]
    declaragent source add <type> <id> --config-file <path>
    declaragent source list

  Configure / inspect
    declaragent tenants list | show <id> | diff
    declaragent secrets list | describe <ref> | rotate <ref>
    declaragent events list --last 20 [--correlation <id>]
    declaragent dlq list --source <id>
    declaragent dlq redrive --source <id> <entryId>
    declaragent audit verify | erase --user <id>
    declaragent fleet list | validate | capabilities | graph | peers | status

  Run / deploy
    declaragent daemon
    declaragent fleet run [--agent <id>...]
    declaragent deploy gcp-cloud-run [--project X --region Y]
    declaragent fleet deploy [--target <name>] [--strategy <rolling|all-or-nothing|per-agent>]
    declaragent fleet deploy --rollback

The user can also run \`/init [<template>] [--force]\` as a slash command
to scaffold into the cwd with the provider already resolved from the
current session.

# Interaction pattern

1. **Understand** — When the user describes what they want, ask at most
   2–3 crisp clarifying questions before proposing anything. Focus on:
   the trigger (what kicks the agent off), the action (what should it
   do), the surface (where does the user see it), and the deploy target.
2. **Propose** — Summarize the design in 3–5 bullets: template pick,
   sources to add, channels, plugins, deploy target. Call out anything
   the user has to supply (API keys, webhook URLs, tenant ids).
3. **Scaffold** — Prefer \`declaragent init --template <t>\` or \`/init\`
   over hand-writing files. After scaffolding, show the agent.yaml.
4. **Iterate** — Edit \`agent.yaml\` / skills / sources by reading first,
   then editing surgically. After any meaningful change, run
   \`declaragent fleet validate\` (for fleets) or just report the diff.
5. **Monitor** — For live-running agents, use \`declaragent events list\`,
   \`declaragent audit verify\`, \`declaragent fleet status --history\`,
   \`declaragent dlq list\` to surface state. Thread on \`correlationId\`.

# Design heuristics

- One agent per **unit of responsibility**. A single agent that reviews
  PRs, triages alerts, and answers Slack is three agents wearing a trench
  coat — split them into a fleet.
- Prefer **declarative** over imperative. YAML + existing tools beat a
  bespoke skill that shells out.
- Templates are the short path. Reach for \`rpc-client\`/\`rpc-server\` when
  the user needs inter-agent requests.
- For enterprise setups, wire tenants.yaml + secrets.yaml early — back-
  filling them later is painful.
- Every capability the user names, show them the exact CLI verb that
  configures it. This site says "one CLI, every step of the lifecycle" —
  live up to it.

# Hard rules

- NEVER write real secrets (API keys, tokens, passwords) into any file.
  Use \`\${env:VAR}\` placeholders and remind the user to put the value in
  \`.env\` (which is gitignored).
- NEVER echo, quote, or paraphrase a \`<redacted:…>\` marker back to the
  user. When you see one in a message it means the builder's leak
  detector already stripped a suspected secret — repeating the marker
  (let alone attempting to reconstruct the value) defeats the purpose.
  Acknowledge the redaction by pointing the user at the
  \`DeclaraAddSecret\` / \`DeclaraAuthPlaybook\` tools and move on.

# Plan-confirm-execute (builder toolkit)

When the user asks for a multi-file change — a new skill, a new
secret, wiring a source / channel — **propose before executing**:

1. Call \`DeclaraProposeChange({ summary, steps: [{ kind, description,
   preview?, payload }] })\`. \`payload\` is the exact arguments the
   matching runner expects (e.g. the \`DeclaraAddSkill\` input shape).
   \`preview\` is a short YAML / diff / command fragment the user reads.
2. Wait for the call to return. It blocks until the user types \`/yes\`,
   \`/no\`, or \`/edit <n> <replacement>\`.
3. If \`confirmed: true\`, immediately call
   \`DeclaraApplyChange({ proposalId })\`. If \`confirmed: false\`,
   explain briefly and re-propose with the user's feedback.

Worked example — user asks "add a pr-review skill":

\`\`\`
DeclaraProposeChange({
  summary: "Add a pr-review skill that summarizes blockers",
  steps: [{
    kind: "addSkill",
    description: "Create skills/pr-review.md and list it in agent.yaml",
    preview: "skills/pr-review.md (new)\\nagent.yaml: + skills/pr-review.md",
    payload: {
      name: "pr-review",
      description: "Review a PR and report blockers.",
      body: "Summarise blockers from the PR at {{url}}."
    }
  }]
}) → { proposalId: "…", confirmed: true }

DeclaraApplyChange({ proposalId: "…" }) → { ok: true, results: […] }
\`\`\`

Never skip the propose step for multi-file work. Direct \`DeclaraAddSkill\`
/ \`DeclaraAddSecret\` calls stay available for one-off, clearly-scoped
additions where the payload is trivial and obviously correct.

# Fleet heuristic

Single-agent sprawl is a known anti-pattern. When the user describes
**two or more distinct responsibilities** (e.g. "Slack concierge that
also reviews PRs", "monitor cron + run on-call escalation"), propose a
**fleet structure** — not a single mega-agent.

In a fleet proposal, include these step kinds in one \`DeclaraProposeChange\`:

1. One \`addAgent\` step per responsibility, each with a payload like
   \`{ template: "concierge" | "pr-review" | "rpc-client" | "rpc-server" | ..., id: "<agent-id>" }\`.
2. One or more \`addPeer\` steps wiring the agent-to-agent calls with
   \`{ agent: "agent://<id>", transports: [{ kind: "memory", topics: { requests: "agents.<id>.requests" }}] }\`.
   Default to \`kind: "memory"\` for dev; the user can swap to kafka /
   nats / sqs / amqp / mqtt once the fleet runs.
3. (Optional) \`addSkill\` / \`addSecret\` steps for per-agent work.

After apply, the user can run \`/fleet graph\` to see the peer topology
rendered inline.

If the user's ask fits cleanly into a single agent (one channel, one
trigger, one responsibility) — stay single. Don't propose a fleet just
because the builder can.

# Monitoring (query before speculating)

When the user asks "what happened?", "is it stuck?", "did the fleet
deploy?", "is the audit chain clean?" — call the read-only inspection
tools BEFORE theorising:

- \`DeclaraEventsTail({ last?, kind?, correlationId? })\` — last N
  entries from the event store. Thread on a correlation id to see one
  causal chain end-to-end.
- \`DeclaraFleetStatus({ history? })\` — the full fleet report. The
  report is authoritative; prefer it to re-reading agent.yaml files.
- \`DeclaraAuditVerify({ tenant? })\` — hash-chain integrity.
  \`{ ok: false }\` means real tamper or data loss; surface the
  violation count and ask the user how to proceed.
- \`DeclaraDlqShow({ sourceId?, limit? })\` — rejected events in the
  session store. Client-side analog of \`declaragent dlq show\`; tell
  the user if they want the broker DLQ they still need the CLI verb.

Running these tools counts against no budget other than the usual
permission mode. They're readonly; in the default mode the gate auto-
approves. Do not ask the user whether to check — just check.
- NEVER run \`declaragent deploy\` or \`declaragent fleet deploy\` without
  the user's explicit "yes, deploy" first. A dry-run is always safer.
  The permission gate **blocks these commands by default** (phase 6).
  When the user asks to deploy:
    1. Call \`DeclaraProposeChange\` with \`requiresExplicitYes: true\`,
       \`summary: "deploy …"\`, and a \`runCommand\` step whose payload
       shows the exact command that would run.
    2. Wait for the user to type \`/yes deploy\` (exact phrase).
    3. Tell the user to run \`/mode bypass\` and execute the command
       themselves, or to re-invoke you with \`--mode bypass\`. The gate
       must be dropped intentionally; the builder never drops it.
- NEVER overwrite a user-edited \`agent.yaml\` without reading the
  current version first and summarizing the diff you intend to apply.
- After any file change, show what changed and where — paths + a one-
  line summary per file. The user should never wonder what you did.
- Keep responses tight. The REPL is a terminal, not a docs page. Prose
  in bullets; code in fenced blocks; full trees only when asked.`;

function defaultSpec(model: string): AgentSpec {
  return {
    name: 'declaragent-repl',
    model,
    systemPrompt: SYSTEM_PROMPT,
  };
}

function extractAssistantText(message: Message | undefined): string {
  if (!message) return '';
  return message.content
    .filter((c): c is Extract<Message['content'][number], { type: 'text' }> => c.type === 'text')
    .map((c) => c.text)
    .join('\n');
}

interface PendingPrompt {
  call: PendingToolCall;
  decision: PermissionDecision;
  resolve: (allow: boolean) => void;
}

interface PickerItem {
  id: string;
  description?: string;
}

interface PickerState {
  items: PickerItem[];
  cursor: number;
  title: string;
  query: string;
}

const PICKER_MAX_VISIBLE = 15;

function filterPickerItems(items: PickerItem[], query: string): PickerItem[] {
  if (!query) return items;
  const q = query.toLowerCase();
  return items.filter(
    (i) => i.id.toLowerCase().includes(q) || (i.description?.toLowerCase().includes(q) ?? false),
  );
}

export function App(props: AppProps): JSX.Element {
  const initialMode: PermissionMode = props.initialMode ?? 'default';

  // Resolve initial model: --model flag > saved per-provider model > preset default.
  const initialCreds = useMemo(() => resolveCredentials(), []);
  const initialModel = useMemo(() => {
    if (props.model) return props.model;
    const providerId = initialCreds?.providerId ?? 'anthropic';
    const cfg = loadConfig();
    const stored = cfg?.providers?.[providerId]?.model;
    if (stored) return stored;
    const preset = getPreset(providerId);
    if (preset?.defaultModel) return preset.defaultModel;
    return defaultModelFor(providerId === 'openrouter' ? 'openrouter' : 'anthropic');
  }, [props.model, initialCreds]);

  const { exit } = useApp();
  const [lines, setLines] = useState<Line[]>(() => {
    const creds = resolveCredentials();
    const banner: Line = {
      kind: 'banner',
      providerId: creds?.providerId ?? 'anthropic',
      model: initialModel,
      mode: initialMode,
      ...(creds?.source && { source: creds.source }),
    };
    return [banner];
  });
  const [input, setInput] = useState('');
  const [busy, setBusy] = useState(false);
  const [mode, setMode] = useState<PermissionMode>(initialMode);
  const [model, setModelState] = useState<string>(initialModel);
  const [pendingPrompt, setPendingPrompt] = useState<PendingPrompt | null>(null);
  const [picker, setPicker] = useState<PickerState | null>(null);
  const [suggestionCursor, setSuggestionCursor] = useState(0);

  // Persistent input history (~/.declaragent/history.jsonl), like a shell.
  // historyIndex === null means we're editing a fresh draft; numeric values
  // index back into history (history.length-1 = most recent).
  const [history, setHistory] = useState<string[]>(() => loadHistory());
  const [historyIndex, setHistoryIndex] = useState<number | null>(null);
  const draftRef = useRef('');

  // Double-Ctrl+C to exit. First press shows a hint; second press within 2s
  // exits. Matches Claude Code / most shell-like REPLs.
  const ctrlCRef = useRef<{ at: number } | null>(null);

  // Slash-command autocomplete: when input starts with `/`, derive matching
  // commands. Restricted to the prefix before the first space so args don't
  // trigger autocomplete after the command name is fixed.
  const slashSuggestions = useMemo(() => {
    if (!input.startsWith('/')) return null;
    const cmdPrefix = input.split(/\s/)[0] ?? '';
    if (cmdPrefix.includes(' ')) return null;
    const lower = cmdPrefix.toLowerCase();
    const matches = SLASH_COMMANDS.filter((c) => {
      const head = (c.name.split(' ')[0] ?? '').toLowerCase();
      return head.startsWith(lower);
    });
    return matches.length > 0 ? matches : null;
  }, [input]);

  // Reset cursor when the suggestion set's identity changes (driven by `input`).
  // biome-ignore lint/correctness/useExhaustiveDependencies: slashSuggestions is the trigger we want.
  useEffect(() => {
    setSuggestionCursor(0);
  }, [slashSuggestions]);

  const linesRef = useRef(lines);
  linesRef.current = lines;

  const append = useCallback((line: Line): void => {
    setLines((prev) => [...prev, line]);
  }, []);

  // Stable instances across renders.
  const store = useMemo<SqliteSessionStore>(
    () => createSqliteSessionStore({ path: sessionsDbPath() }),
    [],
  );
  const sessionRef = useRef<SessionHandle>(store.create(defaultSpec(model)));

  // Builder scope + proposal registry. One per session; tools + slash
  // handlers share the same instance so /yes can resolve a proposal
  // the `DeclaraProposeChange` tool is currently awaiting.
  const scopeRoot = useMemo(() => resolveScopeRootSync(process.cwd()), []);
  const registry = useMemo(() => new ProposalRegistry(), []);
  // Per-session audit sink — `DeclaraApplyChange` writes `tool_call`
  // records here; `/history` reads them back. Opened lazily in a
  // useEffect and closed on unmount. Undefined until opened — the
  // engine useEffect rebuilds once the sink is ready.
  const [auditSink, setAuditSink] = useState<TenantAuditSink | null>(null);

  const engineRef = useRef<Engine | null>(null);
  // Rebuild engine when mode changes (gate is captured by closure).
  useEffect(() => {
    const creds = resolveCredentials();
    if (!creds) {
      append({
        kind: 'error',
        text: 'No credentials. Run `declaragent auth login` or set ANTHROPIC_API_KEY.',
      });
    }
    // Provider/model is shown in the banner + status line; skip the system line.
    // Provider selection driven by the registry preset.
    const preset = creds ? getPreset(creds.providerId) : undefined;
    let provider: LLMProvider;
    if (preset?.kind === 'anthropic') {
      provider = createAnthropicProvider({
        ...(creds?.authToken !== undefined && { authToken: creds.authToken }),
        ...(creds?.apiKey !== undefined && { apiKey: creds.apiKey }),
      });
    } else if (preset?.kind === 'openai-compat') {
      const apiKey = creds?.apiKey ?? creds?.authToken ?? '';
      const baseURL = creds?.baseURL ?? preset.baseURL ?? '';
      const headers: Record<string, string> = { ...(preset.headers ?? {}) };
      // OpenRouter convention: send attribution headers.
      if (preset.id === 'openrouter') {
        headers['HTTP-Referer'] = DECLARAGENT_REFERRER;
        headers['X-Title'] = DECLARAGENT_TITLE;
      }
      provider = createOpenAICompatProvider({
        apiKey,
        baseURL,
        ...(Object.keys(headers).length > 0 && { headers }),
      });
    } else {
      // Fallback: assume anthropic if we can't identify the preset.
      provider = createAnthropicProvider({
        ...(creds?.authToken !== undefined && { authToken: creds.authToken }),
        ...(creds?.apiKey !== undefined && { apiKey: creds.apiKey }),
      });
    }
    // Phase-6 safety floor: deploy verbs are denied by default so a
    // model that Bash-shells `declaragent deploy ...` straight to prod
    // trips the gate rather than the live site. Users who *intend* to
    // deploy swap to `/mode bypass` after confirming the plan.
    const permissions = createPermissionGate({
      mode,
      rules: [...DEFAULT_DEPLOY_DENY_RULES],
    });
    const builderTools = getBuilderTools({
      scopeRoot,
      registry,
      ...(auditSink !== null && { auditSink }),
    });
    engineRef.current = createEngine({
      provider,
      tools: [...BUILTIN_TOOLS, ...builderTools],
      permissions,
      createChildSession: () => store.create(defaultSpec(model)),
      prompter: async (call, decision) => {
        return new Promise<boolean>((resolve) => {
          setPendingPrompt({ call, decision, resolve });
        });
      },
      hooks: {
        onToolCallBefore: (call) => {
          append({
            kind: 'tool',
            toolName: call.toolName,
            status: 'started',
            detail: call.permissionKey,
          });
          return undefined;
        },
        onToolCallAfter: (call) => {
          append({
            kind: 'tool',
            toolName: call.toolName,
            status: call.error ? 'error' : 'ok',
            ...(call.error?.message && { detail: call.error.message }),
          });
        },
      },
    });
  }, [mode, model, store, append, scopeRoot, registry, auditSink]);

  // Open the audit sink once per mount; close on unmount. Failures
  // downgrade to "no audit" — the builder still works, just without
  // history + action log.
  useEffect(() => {
    let sink: TenantAuditSink | null = null;
    let cancelled = false;
    (async () => {
      try {
        sink = await createSqliteAuditSink({ path: auditDbPath() });
        if (cancelled) {
          await sink.close();
          return;
        }
        setAuditSink(sink);
      } catch (err) {
        append({
          kind: 'system',
          text: `audit sink unavailable: ${err instanceof Error ? err.message : String(err)}. /history will be empty.`,
        });
      }
    })();
    return () => {
      cancelled = true;
      if (sink !== null) {
        void sink.close();
      }
    };
  }, [append]);

  // Render proposal lifecycle events as system lines. Subscribed once
  // per component lifetime; the registry drops pending state when the
  // component unmounts via the returned disposer.
  useEffect(() => {
    const dispose = registry.subscribe((ev: ProposalEvent) => {
      switch (ev.type) {
        case 'registered':
          append({ kind: 'system', text: renderProposal(ev.proposal) });
          return;
        case 'edited':
          append({
            kind: 'system',
            text: `proposal ${ev.proposal.id} step ${ev.stepIndex + 1} → ${ev.replacement}`,
          });
          return;
        case 'confirmed':
          append({ kind: 'system', text: `proposal ${ev.proposal.id} confirmed.` });
          return;
        case 'rejected':
          append({ kind: 'system', text: `proposal ${ev.proposal.id} rejected.` });
          return;
        case 'expired':
          append({
            kind: 'system',
            text: `proposal ${ev.proposal.id} expired (15-min TTL). Ask the builder to re-propose.`,
          });
          return;
        case 'applied':
          append({ kind: 'system', text: `proposal ${ev.proposal.id} applied.` });
          return;
      }
    });
    return dispose;
  }, [registry, append]);

  async function runUserMessage(text: string): Promise<void> {
    const engine = engineRef.current;
    if (!engine) {
      append({ kind: 'error', text: 'engine not ready' });
      return;
    }
    setBusy(true);
    append({ kind: 'user', text });
    try {
      const result = await engine.runAgent({
        session: sessionRef.current,
        userMessage: text,
      });
      const reply = extractAssistantText(result.lastAssistantMessage);
      if (reply) append({ kind: 'assistant', text: reply });
      if (result.stopReason !== 'end_turn') {
        const msg = result.error?.message ?? '';
        append({
          kind: 'system',
          text: `[turn ended: ${result.stopReason}${msg ? ` — ${msg}` : ''}]`,
        });
        if (/no endpoints found for/i.test(msg)) {
          append({
            kind: 'system',
            text: 'tip: run /model refresh and pick an id available on your account.',
          });
        }
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      append({ kind: 'error', text: `runAgent threw: ${msg}` });
      if (/no endpoints found for/i.test(msg)) {
        append({
          kind: 'system',
          text: 'tip: run /model refresh and pick an id available on your account.',
        });
      }
    } finally {
      setBusy(false);
    }
  }

  function handleSlash(cmd: SlashCommand): void {
    switch (cmd.kind) {
      case 'help':
        for (const c of SLASH_COMMANDS) {
          append({ kind: 'system', text: `${c.name.padEnd(36)} ${c.description}` });
        }
        return;
      case 'exit':
        store.close();
        exit();
        return;
      case 'cost': {
        const ledger = sessionRef.current.ledger();
        append({
          kind: 'system',
          text: `tokens in=${ledger.inputTokens} out=${ledger.outputTokens} cache=${ledger.cacheReadTokens} turns=${ledger.turns} ~$${ledger.estimatedCostUSD.toFixed(4)}`,
        });
        return;
      }
      case 'rules':
        append({ kind: 'system', text: `mode=${mode} (rules: 0)` });
        return;
      case 'mode':
        setMode(cmd.mode);
        append({ kind: 'system', text: `mode → ${cmd.mode}` });
        return;
      case 'plan':
        setMode('plan');
        append({ kind: 'system', text: 'mode → plan' });
        return;
      case 'model': {
        const providerId = initialCreds?.providerId ?? 'anthropic';
        if (cmd.model) {
          void sessionRef.current.updateSpec({ model: cmd.model });
          setModelState(cmd.model);
          rememberModel(providerId, cmd.model);
          append({ kind: 'system', text: `model → ${cmd.model}` });
          return;
        }
        const preset = getPreset(providerId);
        // OpenRouter — live fetch with rich metadata + 24h cache.
        if (providerId === 'openrouter') {
          append({
            kind: 'system',
            text: cmd.refresh
              ? 'refreshing model list from OpenRouter…'
              : 'fetching model list (cached 24h)…',
          });
          void (async () => {
            try {
              const opts: { force?: boolean } = {};
              if (cmd.refresh) opts.force = true;
              const result = await fetchOpenRouterModels(opts);
              const list = [...result.models].sort((a, b) => a.id.localeCompare(b.id));
              const items: PickerItem[] = list.map((m) => {
                const summary = summarizeModel(m);
                const item: PickerItem = { id: m.id };
                if (summary) item.description = summary;
                return item;
              });
              setPicker({
                items,
                cursor: Math.max(
                  0,
                  items.findIndex((i) => i.id === model),
                ),
                title: `Select model (${list.length} models · source: ${result.source})`,
                query: '',
              });
            } catch (err) {
              append({
                kind: 'error',
                text: `OpenRouter fetch failed: ${
                  err instanceof Error ? err.message : String(err)
                }`,
              });
            }
          })();
          return;
        }
        // Anthropic — static curated list.
        if (providerId === 'anthropic') {
          const items: PickerItem[] = knownModelsFor('anthropic').map((m) => ({
            id: m.id,
            description: m.label,
          }));
          setPicker({
            items,
            cursor: Math.max(
              0,
              items.findIndex((i) => i.id === model),
            ),
            title: 'Select model (provider: anthropic)',
            query: '',
          });
          return;
        }
        // Any other openai-compat provider — try the standard /v1/models endpoint.
        if (preset?.kind === 'openai-compat' && preset.baseURL) {
          append({ kind: 'system', text: `fetching ${preset.label} models…` });
          const apiKey = initialCreds?.apiKey ?? initialCreds?.authToken ?? '';
          const baseURL = initialCreds?.baseURL ?? preset.baseURL;
          void (async () => {
            try {
              const list = await fetchOpenAICompatModels(baseURL, apiKey);
              const items: PickerItem[] = list
                .map((m) => ({ id: m.id }))
                .sort((a, b) => a.id.localeCompare(b.id));
              setPicker({
                items,
                cursor: Math.max(
                  0,
                  items.findIndex((i) => i.id === model),
                ),
                title: `Select model (${items.length} models · ${preset.label})`,
                query: '',
              });
            } catch (err) {
              append({
                kind: 'error',
                text: `models fetch failed: ${
                  err instanceof Error ? err.message : String(err)
                }. Use /model <id> to set directly.`,
              });
            }
          })();
          return;
        }
        append({
          kind: 'system',
          text: `no model picker available for provider ${providerId} — use /model <id>`,
        });
        return;
      }
      case 'clear': {
        sessionRef.current = store.create(defaultSpec(model));
        const provId = initialCreds?.providerId ?? 'anthropic';
        const banner: Line = {
          kind: 'banner',
          providerId: provId,
          model,
          mode,
          ...(initialCreds?.source && { source: initialCreds.source }),
        };
        setLines([banner]);
        append({ kind: 'system', text: `new session ${sessionRef.current.id}` });
        return;
      }
      case 'compact':
        append({
          kind: 'system',
          text: 'compact: not implemented in v0.1 (Phase 2 — pluggable strategies)',
        });
        return;
      case 'memory': {
        const path = memoryFilePath();
        if (!existsSync(path)) {
          append({ kind: 'system', text: `no CLAUDE.md at ${path}` });
          return;
        }
        const text = readFileSync(path, 'utf8');
        append({ kind: 'system', text: `--- ${path} ---\n${text}` });
        return;
      }
      case 'init': {
        const template = cmd.template ?? 'concierge';
        if (!isTemplateName(template)) {
          append({
            kind: 'error',
            text: `unknown template "${template}". Available: ${TEMPLATE_NAMES.join(', ')}.`,
          });
          return;
        }
        const providerId = initialCreds?.providerId ?? 'anthropic';
        const preset = getPreset(providerId);
        try {
          const result = unpackTemplate({
            template: template as TemplateName,
            outDir: process.cwd(),
            providerId,
            providerEnvVar: preset?.envVar ?? '',
            force: cmd.force === true,
            multiTenant: false,
          });
          for (const p of result.written) {
            append({ kind: 'system', text: `  wrote ${p}` });
          }
          for (const p of result.skipped) {
            append({ kind: 'system', text: `  skipped ${p} (exists — pass --force to overwrite)` });
          }
          append({
            kind: 'system',
            text: `✓ scaffolded template "${template}" into ${process.cwd()}. Edit agent.yaml then /clear to restart the session.`,
          });
        } catch (err) {
          append({
            kind: 'error',
            text: `/init failed: ${err instanceof Error ? err.message : String(err)}`,
          });
        }
        return;
      }
      case 'sessions': {
        const list = store.list();
        if (list.length === 0) {
          append({ kind: 'system', text: 'no persisted sessions' });
          return;
        }
        for (const s of list.slice(0, 20)) {
          append({
            kind: 'system',
            text: `${s.id}  msgs=${s.messageCount}  ${s.specName}  ${s.updatedAt.toISOString()}`,
          });
        }
        return;
      }
      case 'resume': {
        if (!cmd.sessionId) {
          append({ kind: 'system', text: 'usage: /resume <session-id> (see /sessions)' });
          return;
        }
        const opened = store.open(cmd.sessionId);
        if (!opened) {
          append({ kind: 'error', text: `no session ${cmd.sessionId}` });
          return;
        }
        sessionRef.current = opened;
        append({
          kind: 'system',
          text: `resumed ${cmd.sessionId} with ${opened.transcript.length} message(s)`,
        });
        return;
      }
      case 'planPropose': {
        // `/plan <description>` — hand off to the model with a clear
        // instruction to use the builder's propose flow. The model
        // emits a DeclaraProposeChange call; the registry's listener
        // renders it; the user responds with /yes /no /edit.
        void runUserMessage(
          `Use DeclaraProposeChange to draft a plan for the following goal — do NOT execute it yet, just propose: ${cmd.description}`,
        );
        return;
      }
      case 'proposalYes': {
        const active = registry.active();
        if (!active) {
          append({ kind: 'system', text: 'no pending proposal.' });
          return;
        }
        if (active.requiresExplicitYes) {
          // Require an exact, proposal-summary-derived phrase so a
          // reflexive "/yes" can't approve a destructive op (§5.4).
          const expected = explicitYesPhrase(active);
          if (cmd.phrase !== expected) {
            append({
              kind: 'system',
              text: `this proposal requires "/yes ${expected}" — exact phrase.`,
            });
            return;
          }
        }
        const ok = registry.confirm(active.id);
        if (!ok) {
          append({ kind: 'system', text: 'could not confirm — proposal no longer pending.' });
        }
        return;
      }
      case 'proposalNo': {
        const active = registry.active();
        if (!active) {
          append({ kind: 'system', text: 'no pending proposal.' });
          return;
        }
        registry.reject(active.id);
        return;
      }
      case 'proposalEdit': {
        const active = registry.active();
        if (!active) {
          append({ kind: 'system', text: 'no pending proposal to edit.' });
          return;
        }
        const idx = cmd.stepNumber - 1;
        const ok = registry.edit(active.id, idx, cmd.replacement);
        if (!ok) {
          append({
            kind: 'error',
            text: `step ${cmd.stepNumber} is out of range (1..${active.steps.length}).`,
          });
        }
        return;
      }
      case 'proposalEditInvalid':
        append({ kind: 'error', text: cmd.reason });
        return;
      case 'diff': {
        void (async () => {
          const target = cmd.path ?? scopeRoot;
          const r = await runGitRaw(scopeRoot, ['diff', '--', target]);
          if (r.code !== 0) {
            append({
              kind: 'error',
              text: `git diff failed: ${r.stderr.trim() || r.stdout.trim() || `exit ${r.code}`}`,
            });
            return;
          }
          append({
            kind: 'system',
            text: r.stdout.trim().length === 0 ? 'no changes.' : r.stdout,
          });
        })();
        return;
      }
      case 'scope':
        append({ kind: 'system', text: `scope root: ${scopeRoot}` });
        return;
      case 'undo': {
        void (async () => {
          const res = await runUndo({ registry, scopeRoot });
          append({ kind: res.ok ? 'system' : 'error', text: res.message });
        })();
        return;
      }
      case 'history': {
        if (auditSink === null) {
          append({ kind: 'system', text: 'audit sink not ready yet — try again in a moment.' });
          return;
        }
        void (async () => {
          try {
            const out = await runHistory({
              sink: auditSink,
              ...(cmd.limit !== undefined && { limit: cmd.limit }),
            });
            append({ kind: 'system', text: renderHistory(out) });
          } catch (err) {
            append({
              kind: 'error',
              text: `history query failed: ${err instanceof Error ? err.message : String(err)}`,
            });
          }
        })();
        return;
      }
      case 'fleetGraph': {
        void (async () => {
          const chunks: string[] = [];
          const errs: string[] = [];
          const code = await fleetGraph(
            {
              ...(cmd.format !== undefined && { format: cmd.format }),
            },
            {
              root: scopeRoot,
              io: {
                out: (s) => {
                  chunks.push(s);
                },
                err: (s) => {
                  errs.push(s);
                },
              },
            },
          );
          if (code !== 0) {
            append({
              kind: 'error',
              text: errs.join('').trim() || `fleet graph exited with code ${code}`,
            });
            return;
          }
          append({ kind: 'system', text: chunks.join('').trimEnd() });
        })();
        return;
      }
      case 'unknown':
        append({
          kind: 'error',
          text: `unknown command: /${cmd.name}. try /help`,
        });
        return;
    }
  }

  /**
   * Derive the explicit-yes phrase for a proposal that requires one
   * (§5.4). The first word of the summary is usually the verb
   * ("deploy", "erase", etc.); we use it lowercased as the required
   * phrase. Callers surface this in the rendered plan so the user sees
   * exactly what to type.
   */
  function explicitYesPhrase(p: Proposal): string {
    const first = p.summary.trim().split(/\s+/)[0] ?? 'confirm';
    return first.toLowerCase();
  }

  async function handleSubmit(value: string): Promise<void> {
    const raw = value.trim();
    setInput('');
    if (raw.length === 0) return;
    // Pre-turn leak detection (BUILDER_PLAN §5.1). The raw value is
    // *discarded* after this call — only the redacted form lands in
    // the transcript, history, session store, or engine request.
    const { redacted: text, findings } = redactSecrets(raw);
    if (findings.length > 0) {
      append({ kind: 'system', text: formatLeakWarning(findings) });
    }
    // Record in history before dispatch so a crashing tool still leaves a trail.
    if (history[history.length - 1] !== text) {
      setHistory((h) => [...h, text].slice(-1000));
      appendHistory(text);
    }
    setHistoryIndex(null);
    draftRef.current = '';
    const cmd = parseSlash(text);
    if (cmd) {
      handleSlash(cmd);
      return;
    }
    await runUserMessage(text);
  }

  function resolvePrompt(allow: boolean): void {
    if (pendingPrompt) {
      pendingPrompt.resolve(allow);
      append({
        kind: 'system',
        text: `permission ${allow ? 'granted' : 'denied'} for ${pendingPrompt.call.toolName}:${pendingPrompt.call.permissionKey}`,
      });
      setPendingPrompt(null);
    }
  }

  // Ctrl+C — first press warns, second press within 2s exits.
  useInput((inputChar, key) => {
    if (!key.ctrl || inputChar !== 'c') return;
    const now = Date.now();
    const prev = ctrlCRef.current;
    if (prev && now - prev.at < 2000) {
      ctrlCRef.current = null;
      store.close();
      exit();
      return;
    }
    ctrlCRef.current = { at: now };
    append({
      kind: 'system',
      text: '(press Ctrl+C again within 2s to exit, or /exit)',
    });
  });

  // Picker key handler: arrows + enter + escape navigate the list,
  // printable chars / backspace edit the search query.
  useInput(
    (inputChar, key) => {
      if (!picker) return;
      if (key.escape) {
        append({ kind: 'system', text: 'picker cancelled' });
        setPicker(null);
        return;
      }
      if (key.return) {
        const filtered = filterPickerItems(picker.items, picker.query);
        const chosen = filtered[picker.cursor];
        if (chosen) {
          const providerId = initialCreds?.providerId ?? 'anthropic';
          void sessionRef.current.updateSpec({ model: chosen.id });
          setModelState(chosen.id);
          rememberModel(providerId, chosen.id);
          append({ kind: 'system', text: `model → ${chosen.id}` });
        }
        setPicker(null);
        return;
      }
      if (key.upArrow) {
        setPicker((p) => (p ? { ...p, cursor: Math.max(0, p.cursor - 1) } : null));
        return;
      }
      if (key.downArrow) {
        setPicker((p) => {
          if (!p) return null;
          const len = filterPickerItems(p.items, p.query).length;
          return { ...p, cursor: Math.min(Math.max(0, len - 1), p.cursor + 1) };
        });
        return;
      }
      if (key.backspace || key.delete) {
        setPicker((p) => (p ? { ...p, query: p.query.slice(0, -1), cursor: 0 } : null));
        return;
      }
      if (inputChar && inputChar.length === 1 && !key.ctrl && !key.meta && inputChar >= ' ') {
        setPicker((p) => (p ? { ...p, query: p.query + inputChar, cursor: 0 } : null));
      }
    },
    { isActive: picker !== null },
  );

  // Autocomplete key handler: only active when there are slash suggestions
  // and no other modal is taking input.
  useInput(
    (_char, key) => {
      if (!slashSuggestions) return;
      if (key.upArrow) {
        setSuggestionCursor((c) => Math.max(0, c - 1));
        return;
      }
      if (key.downArrow) {
        setSuggestionCursor((c) => Math.min(slashSuggestions.length - 1, c + 1));
        return;
      }
      if (key.tab) {
        const chosen = slashSuggestions[suggestionCursor];
        if (chosen) {
          const head = chosen.name.split(' ')[0] ?? '';
          // Append a trailing space when the command takes args, so the user
          // can immediately start typing them.
          const takesArgs = chosen.name.includes(' ');
          setInput(takesArgs ? `${head} ` : head);
        }
      }
    },
    {
      isActive: slashSuggestions !== null && !picker && !pendingPrompt && !busy,
    },
  );

  // Shell-style history: ↑ recalls previous submissions, ↓ moves forward.
  // Only active when no other modal owns input AND no slash suggestions are
  // up (those use ↑/↓ for their own list).
  useInput(
    (_char, key) => {
      if (history.length === 0) return;
      if (key.upArrow) {
        if (historyIndex === null) {
          draftRef.current = input;
          const idx = history.length - 1;
          setHistoryIndex(idx);
          setInput(history[idx] ?? '');
        } else if (historyIndex > 0) {
          const idx = historyIndex - 1;
          setHistoryIndex(idx);
          setInput(history[idx] ?? '');
        }
        return;
      }
      if (key.downArrow) {
        if (historyIndex === null) return;
        const next = historyIndex + 1;
        if (next >= history.length) {
          setInput(draftRef.current);
          setHistoryIndex(null);
        } else {
          setHistoryIndex(next);
          setInput(history[next] ?? '');
        }
      }
    },
    {
      isActive: !picker && !pendingPrompt && !busy && slashSuggestions === null,
    },
  );

  const ledger = sessionRef.current.ledger();
  const providerId = initialCreds?.providerId ?? 'anthropic';

  return (
    <Box flexDirection="column" paddingX={1}>
      <Static items={lines}>{(line, i) => renderLine(line, i)}</Static>
      <Box marginTop={1} flexDirection="column">
        {picker ? (
          <Box borderStyle="round" borderColor="cyan" paddingX={1} flexDirection="column">
            <PickerBox state={picker} currentId={model} />
          </Box>
        ) : pendingPrompt ? (
          <Box borderStyle="round" borderColor="yellow" paddingX={1} flexDirection="column">
            <PromptRow prompt={pendingPrompt} onResolve={resolvePrompt} />
          </Box>
        ) : busy ? (
          <Box borderStyle="round" borderColor="yellow" paddingX={1}>
            <Text color="yellow">… working …</Text>
          </Box>
        ) : (
          <>
            {slashSuggestions ? (
              <SlashSuggestions suggestions={slashSuggestions} cursor={suggestionCursor} />
            ) : null}
            <Box borderStyle="round" borderColor="gray" paddingX={1}>
              <Text color="cyan">› </Text>
              <TextInput value={input} onChange={setInput} onSubmit={handleSubmit} />
            </Box>
          </>
        )}
        <Box marginTop={0} paddingX={1}>
          <Text color="gray">
            {providerId}/{model} · {mode} · in={ledger.inputTokens} out=
            {ledger.outputTokens} · ${ledger.estimatedCostUSD.toFixed(4)}
            {'  ·  /help for commands'}
          </Text>
        </Box>
      </Box>
    </Box>
  );
}

interface SlashSuggestionsProps {
  suggestions: typeof SLASH_COMMANDS;
  cursor: number;
}

const MAX_SUGGESTIONS_VISIBLE = 6;

function SlashSuggestions({ suggestions, cursor }: SlashSuggestionsProps): JSX.Element {
  const visible = suggestions.slice(0, MAX_SUGGESTIONS_VISIBLE);
  const hidden = suggestions.length - visible.length;
  return (
    <Box flexDirection="column" paddingX={1}>
      {visible.map((s, i) => {
        const selected = i === cursor;
        return (
          <Text key={s.name} color={selected ? 'cyan' : 'gray'}>
            {selected ? '▶ ' : '  '}
            <Text color={selected ? 'cyan' : 'white'}>{s.name.padEnd(36)}</Text>
            <Text color="gray"> {s.description}</Text>
          </Text>
        );
      })}
      {hidden > 0 ? <Text color="gray"> …{hidden} more</Text> : null}
      <Text color="gray"> ↑/↓ navigate · tab complete · enter run</Text>
    </Box>
  );
}

interface PickerBoxProps {
  state: PickerState;
  currentId: string;
}

function PickerBox({ state, currentId }: PickerBoxProps): JSX.Element {
  const filtered = filterPickerItems(state.items, state.query);
  const visible = filtered.slice(0, PICKER_MAX_VISIBLE);
  const hidden = filtered.length - visible.length;
  return (
    <Box flexDirection="column">
      <Text color="cyan">{state.title}</Text>
      <Text>
        <Text color="gray">filter › </Text>
        {state.query ? (
          <Text color="yellow">{state.query}</Text>
        ) : (
          <Text color="gray">(type to search)</Text>
        )}
        <Text color="gray">
          {' '}
          {filtered.length}/{state.items.length} matches
        </Text>
      </Text>
      {filtered.length === 0 ? (
        <Text color="red"> no matches — backspace to clear</Text>
      ) : (
        visible.map((item, i) => {
          const selected = i === state.cursor;
          const isCurrent = item.id === currentId;
          const marker = selected ? '▶' : isCurrent ? '●' : ' ';
          return (
            <Text key={item.id} color={selected ? 'cyan' : isCurrent ? 'green' : 'white'}>
              {` ${marker} ${item.id.padEnd(42)}`}
              {item.description ? <Text color="gray">{` ${item.description}`}</Text> : null}
            </Text>
          );
        })
      )}
      {hidden > 0 ? <Text color="gray"> …{hidden} more (refine search to narrow)</Text> : null}
      <Text color="gray">{'  type to filter · ↑/↓ navigate · enter select · esc cancel'}</Text>
    </Box>
  );
}

function renderLine(line: Line, key: number): JSX.Element {
  switch (line.kind) {
    case 'user':
      return (
        <Text key={key}>
          <Text color="cyan">you › </Text>
          {line.text}
        </Text>
      );
    case 'assistant':
      return (
        <Box key={key} flexDirection="column" marginTop={1} marginBottom={1}>
          <Text color="green">claude</Text>
          <Text>{line.text}</Text>
        </Box>
      );
    case 'tool': {
      const sigil = line.status === 'started' ? '⏵' : line.status === 'ok' ? '✓' : '✗';
      const color = line.status === 'error' ? 'red' : line.status === 'ok' ? 'green' : 'yellow';
      return (
        <Text key={key}>
          <Text color={color}>
            {sigil} {line.toolName}
          </Text>
          {line.detail ? <Text color="gray"> {line.detail}</Text> : null}
        </Text>
      );
    }
    case 'system':
      return (
        <Text key={key} color="gray">
          {line.text}
        </Text>
      );
    case 'error':
      return (
        <Text key={key} color="red">
          {line.text}
        </Text>
      );
    case 'banner':
      return (
        <Banner
          key={key}
          providerId={line.providerId}
          model={line.model}
          mode={line.mode}
          {...(line.source && { source: line.source })}
        />
      );
  }
}

interface PromptRowProps {
  prompt: PendingPrompt;
  onResolve: (allow: boolean) => void;
}

function PromptRow({ prompt, onResolve }: PromptRowProps): JSX.Element {
  const [value, setValue] = useState('');
  function submit(v: string): void {
    const c = v.trim().toLowerCase();
    onResolve(c === 'y' || c === 'yes');
    setValue('');
  }
  return (
    <Box flexDirection="column">
      <Text color="yellow">
        ⚠ allow {prompt.call.toolName}:{prompt.call.permissionKey} ? (y/N)
      </Text>
      <Box>
        <Text color="yellow">› </Text>
        <TextInput value={value} onChange={setValue} onSubmit={submit} />
      </Box>
    </Box>
  );
}
