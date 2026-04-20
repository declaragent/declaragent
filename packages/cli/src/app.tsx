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
import { Box, Static, Text, useApp, useInput } from 'ink';
import TextInput from 'ink-text-input';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { loadConfig, rememberModel, resolveCredentials } from './auth.js';
import { Banner } from './banner.js';
import { appendHistory, loadHistory } from './history.js';
import { defaultModelFor, knownModelsFor } from './known-models.js';
import { fetchOpenAICompatModels } from './openai-compat-models.js';
import { fetchOpenRouterModels, summarizeModel } from './openrouter-models.js';
import { DECLARAGENT_REFERRER, DECLARAGENT_TITLE } from './openrouter-oauth.js';
import { memoryFilePath, sessionsDbPath } from './paths.js';
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

const SYSTEM_PROMPT = `You are Declaragent, a developer assistant running locally in a REPL.
You have access to file-reading, file-writing, search, shell-execution, and sub-agent tools.
Be concise. Prefer reading code over guessing.`;

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
    const permissions = createPermissionGate({ mode, rules: [] });
    engineRef.current = createEngine({
      provider,
      tools: BUILTIN_TOOLS,
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
  }, [mode, model, store, append]);

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
      case 'unknown':
        append({
          kind: 'error',
          text: `unknown command: /${cmd.name}. try /help`,
        });
        return;
    }
  }

  async function handleSubmit(value: string): Promise<void> {
    const text = value.trim();
    setInput('');
    if (text.length === 0) return;
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
