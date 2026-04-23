/**
 * Replay harness for recorded-conversation builder fixtures. Enterprise
 * Production Plan §3 Item #12.
 *
 * A fixture is a JSONL file under `packages/cli/src/builder/fixtures/`,
 * where each line is a transcript entry. The harness feeds the
 * recorded assistant messages back through the real {@link createEngine}
 * via a stub provider that matches `LLMProvider` exactly — no
 * short-circuits around permission, hook, or apply-change logic. The
 * point is to prove the system prompt's emitted tool-call sequence
 * still drives the same `DeclaraApplyChange` step kinds in the current
 * build.
 *
 * Fixture entry shapes (JSONL, one JSON object per line):
 *
 *   // 1. User message — kicks off one `engine.runAgent()` turn.
 *   { "role": "user", "text": "build me a webhook triager" }
 *
 *   // 2. Assistant response — replayed verbatim by the stub provider.
 *   //    `content` is the literal MessageContent[] the model emitted.
 *   //    `stopReason` is optional; inferred from content when missing
 *   //    (tool_use blocks → "tool_use", otherwise "end_turn").
 *   { "role": "assistant", "content": [ ... ] }
 *
 * The harness doesn't record `tool_result` entries — those are
 * synthesised at replay time by letting the engine actually execute
 * the tool. That's the whole point: we're proving that the current
 * Engine + tool wiring, given the recorded assistant sequence, lands
 * on the same `DeclaraApplyChange` step kinds as it did when the
 * transcript was captured.
 *
 * Proposals auto-confirm via a registry listener so `DeclaraProposeChange`
 * doesn't wedge the loop waiting on a user `/yes`. Real REPL sessions
 * block; replay always says yes.
 *
 * @since 0.6.x (Enterprise Production Plan #12)
 */

import { readFileSync } from 'node:fs';
import {
  type AgentSpec,
  type LLMProvider,
  type LLMRequest,
  type LLMResponse,
  type Message,
  type SessionHandle,
  type SessionLedger,
  type Tool,
  type ToolEvent,
  type TurnStatus,
  createEngine,
  createPermissionGate,
} from '@declaragent/core';

/**
 * Local alias for the engine's `MessageContent` union. Kept as a
 * `LLMResponse['content'][number]` pass-through so fixture shapes don't
 * depend on a specific re-export path — the channels-layer type was
 * renamed to `ChannelMessageContent` (backlog item #41), so the
 * top-level `MessageContent` now unambiguously resolves to this union,
 * but going through `LLMResponse` keeps the fixture immune to any
 * future surface reshuffles.
 */
type LLMContent = LLMResponse['content'][number];
import { createAddChannelTool } from '../add-channel.js';
import { createAddMCPTool } from '../add-mcp.js';
import { createAddPeerTool } from '../add-peer.js';
import { createAddPluginTool } from '../add-plugin.js';
import { createAddSecretTool } from '../add-secret.js';
import { createAddSkillTool } from '../add-skill.js';
import { createAddSourceTool } from '../add-source.js';
import { createApplyChangeTool } from '../apply-change.js';
import { createAuthPlaybookTool } from '../auth-playbook.js';
import { createFleetAddTool } from '../fleet-add.js';
import type { ProposalStepKind } from '../proposals.js';
import { ProposalRegistry } from '../proposals.js';
import { createProposeChangeTool } from '../propose-change.js';
import { redactSecrets } from '../secret-guard.js';

// ── Fixture JSONL shape ────────────────────────────────────────────────

/**
 * Narrow to the tool_result variant of the engine's content union.
 * Re-exported here so fixture authors can type-annotate a
 * `toolResults` payload without reaching into `recording-provider.ts`
 * from their fixture author-tooling.
 */
export type ToolResultBlock = Extract<LLMContent, { type: 'tool_result' }>;

/**
 * Usage telemetry captured per assistant turn. Today's capture path
 * surfaces cache-token fields + server-side timestamps so CI can
 * assert cache-hit-rate + TTFT regressions against recorded fixtures
 * (backlog items #36 + #37). All fields optional — pre-0.7.6
 * fixtures without the new columns replay unchanged.
 */
export interface FixtureUsage {
  readonly inputTokens?: number;
  readonly outputTokens?: number;
  readonly cacheCreationInputTokens?: number;
  readonly cacheReadInputTokens?: number;
  readonly serverTimestamps?: {
    readonly firstToken: string;
    readonly lastToken: string;
  };
}

export type FixtureEntry =
  | { readonly role: 'user'; readonly text: string }
  | {
      readonly role: 'assistant';
      readonly content: readonly LLMContent[];
      readonly stopReason?: 'end_turn' | 'tool_use' | 'max_tokens' | 'error';
      readonly usage?: FixtureUsage;
      readonly model?: string;
      /**
       * Tool-result blocks emitted by the provider (backlog #36).
       * Kept optional because today the non-streaming `complete()`
       * path never surfaces them directly — tool results land in the
       * *next* user-role message's `content` array. A future
       * streaming provider that emits `tool_result` as first-class
       * content blocks will populate this field; the replay harness
       * threads them back into the engine at the corresponding
       * stream position.
       */
      readonly toolResults?: readonly ToolResultBlock[];
    };

/**
 * Load a JSONL fixture. Blank lines and `#`-prefixed lines are ignored
 * so fixtures can carry human-readable notes without a separate file.
 */
export function loadFixture(path: string): FixtureEntry[] {
  const raw = readFileSync(path, 'utf8');
  const entries: FixtureEntry[] = [];
  for (const [i, line] of raw.split('\n').entries()) {
    const trimmed = line.trim();
    if (trimmed.length === 0) continue;
    if (trimmed.startsWith('#')) continue;
    let parsed: unknown;
    try {
      parsed = JSON.parse(trimmed);
    } catch (err) {
      throw new Error(
        `fixture ${path}: invalid JSON on line ${i + 1}: ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
    }
    entries.push(parsed as FixtureEntry);
  }
  return entries;
}

// ── Stub provider ──────────────────────────────────────────────────────

/**
 * `LLMProvider` that replays recorded assistant messages verbatim.
 * Matches the interface exactly so the engine's codepath is identical
 * to production — no permission bypass, no hook short-circuit, no
 * apply-change shortcut. Exhausts with a descriptive error so a runaway
 * tool loop is obvious (same contract as `FakeProvider` in core/testing).
 */
export class RecordedProvider implements LLMProvider {
  readonly name = 'recorded';
  readonly requests: LLMRequest[] = [];
  private index = 0;

  constructor(
    private readonly responses: readonly LLMResponse[],
    /**
     * Resolves the `"__LATEST__"` placeholder in recorded tool-call
     * inputs to the most-recently-registered proposal's real UUID.
     * Real-recorded fixtures will hold concrete UUIDs; hand-authored
     * ones use the placeholder because the registry mints the id at
     * register time. Injected by {@link replayFixture} so the
     * provider stays pure.
     */
    private readonly resolveLatestProposalId?: () => string | undefined,
  ) {}

  async complete(request: LLMRequest, _signal: AbortSignal): Promise<LLMResponse> {
    this.requests.push(request);
    const response = this.responses[this.index];
    if (!response) {
      throw new Error(
        `RecordedProvider: fixture exhausted after ${this.index} response(s). ` +
          `The engine asked for another completion; the fixture only holds ${this.responses.length}.`,
      );
    }
    this.index += 1;
    return this.rewriteProposalIds(response);
  }

  async countTokens(_messages: Message[]): Promise<number> {
    return 0;
  }

  get callCount(): number {
    return this.index;
  }

  /**
   * Walk the response's content array and replace any `tool_use`
   * block's `input.proposalId` that equals the `"__LATEST__"`
   * sentinel. Non-matching inputs pass through untouched.
   */
  private rewriteProposalIds(response: LLMResponse): LLMResponse {
    const resolver = this.resolveLatestProposalId;
    if (!resolver) return response;
    const rewritten: LLMContent[] = response.content.map((block) => {
      if (block.type !== 'tool_use') return block;
      const input = block.input as { proposalId?: unknown } | null | undefined;
      if (!input || input.proposalId !== '__LATEST__') return block;
      const real = resolver();
      if (!real) return block;
      return { ...block, input: { ...input, proposalId: real } };
    });
    return { ...response, content: rewritten };
  }
}

// ── Minimal session (copies core/testing/memory-session) ───────────────

const DEFAULT_SPEC: AgentSpec = {
  name: 'builder-replay',
  model: 'claude-opus-4-7',
  systemPrompt: 'conversational builder under replay — see replay-harness.ts header.',
};

/**
 * In-memory `SessionHandle`. Duplicated from `core/testing/memory-session.ts`
 * rather than imported because the testing module isn't part of the
 * published surface of `@declaragent/core`; we don't want to couple
 * the replay harness to an internal path that could move.
 */
function createReplaySession(spec: Partial<AgentSpec> = {}): SessionHandle {
  const messages: Message[] = [];
  const turnStatuses = new Map<string, TurnStatus>();
  let currentSpec: AgentSpec = { ...DEFAULT_SPEC, ...spec };
  const id = `replay-${crypto.randomUUID()}`;
  const ledger: SessionLedger = {
    inputTokens: 0,
    outputTokens: 0,
    cacheReadTokens: 0,
    turns: 0,
    estimatedCostUSD: 0,
  };
  return {
    id,
    get spec(): AgentSpec {
      return currentSpec;
    },
    get transcript(): ReadonlyArray<Message> {
      return messages;
    },
    async appendMessage(m: Message): Promise<void> {
      messages.push(m);
      const usage = m.meta?.usage;
      if (usage) {
        ledger.inputTokens += usage.inputTokens;
        ledger.outputTokens += usage.outputTokens;
        if (usage.cacheReadTokens) ledger.cacheReadTokens += usage.cacheReadTokens;
        // Cost estimation is out of scope for the replay harness; real
        // sessions compute this via core/session/pricing, which isn't
        // part of the public `@declaragent/core` export surface.
      }
    },
    ledger(): SessionLedger {
      return { ...ledger };
    },
    async markTurn(turnId: string, status: TurnStatus): Promise<void> {
      turnStatuses.set(turnId, status);
      if (status === 'ok') ledger.turns += 1;
    },
    async updateSpec(patch: Partial<AgentSpec>): Promise<void> {
      currentSpec = { ...currentSpec, ...patch };
    },
  };
}

// ── Apply-change spy ───────────────────────────────────────────────────

/**
 * Wrap {@link createApplyChangeTool} so every step it dispatches lands
 * in {@link capturedStepKinds}, regardless of per-step ok/fail state.
 * We inspect the proposal BEFORE the real tool runs — that way a
 * malformed payload that the dispatcher rejects still shows up in the
 * kind list, which keeps fixtures focused on "what did the model ask
 * for" vs. "did every step succeed."
 */
function wrapApplyChange(
  inner: Tool<{ proposalId: string }, unknown>,
  registry: ProposalRegistry,
  capturedStepKinds: ProposalStepKind[],
  appliedResults: Array<{
    readonly proposalId: string;
    readonly ok: boolean;
    readonly firstError?: string;
  }>,
): Tool<{ proposalId: string }, unknown> {
  return {
    ...inner,
    async *execute(input, ctx): AsyncIterable<ToolEvent<unknown>> {
      // Capture step kinds before execution — the engine rolls back on
      // step failure and we still want the kind list the model emitted.
      const proposal = registry.get(input.proposalId);
      if (proposal) {
        for (const step of proposal.steps) {
          capturedStepKinds.push(step.kind);
        }
      }
      for await (const ev of inner.execute(input, ctx)) {
        if (ev.type === 'result') {
          const out = ev.output as
            | { ok?: boolean; results?: ReadonlyArray<{ ok: boolean; error?: string }> }
            | undefined;
          const firstFail = out?.results?.find((r) => !r.ok);
          appliedResults.push({
            proposalId: input.proposalId,
            ok: out?.ok === true,
            ...(firstFail?.error !== undefined && { firstError: firstFail.error }),
          });
        }
        yield ev;
      }
    },
  };
}

// ── Auto-confirm listener ──────────────────────────────────────────────

/**
 * Subscribe to the registry and auto-confirm every `registered`
 * proposal on the next microtask. Real REPLs block on user input;
 * replay always says yes so the loop finishes deterministically. The
 * microtask defer matters: `DeclaraProposeChange` registers the
 * proposal then awaits resolution — if we confirmed synchronously in
 * the listener the resolver might not be installed yet.
 */
function autoConfirmProposals(
  registry: ProposalRegistry,
  scopeEscapeRejectIds: Set<string> = new Set(),
): () => void {
  return registry.subscribe((event) => {
    if (event.type !== 'registered') return;
    const id = event.proposal.id;
    queueMicrotask(() => {
      // `scopeEscapeRejectIds` lets fixture authors flag proposals the
      // user would have rejected (the "scope escape" fixture uses this
      // to prove the rejection path still terminates cleanly).
      if (scopeEscapeRejectIds.has(id)) {
        registry.reject(id);
      } else {
        registry.confirm(id);
      }
    });
  });
}

// ── Replay options + result ────────────────────────────────────────────

export interface ReplayFixtureOptions {
  /** Absolute path to the JSONL fixture. */
  readonly fixturePath: string;
  /** Scope root the builder tools operate against (usually a tmpdir). */
  readonly scopeRoot: string;
  /**
   * Set of proposal summaries (substring match) the fixture expects the
   * user to /no. The scope-escape fixture declares its summary here.
   */
  readonly rejectProposalSummaries?: ReadonlyArray<string>;
  /**
   * Pre-process each `user` entry through the builder's secret
   * redactor so the "leaked token → redaction" fixture proves the
   * `<redacted:…>` placeholder is what the engine sees.
   */
  readonly redactUserMessages?: boolean;
}

export interface ReplayFixtureResult {
  /**
   * Ordered list of step kinds the harness saw arrive at
   * `DeclaraApplyChange`. One entry per step, regardless of per-step
   * ok/fail state; empty when no proposal made it past /yes.
   */
  readonly appliedStepKinds: readonly ProposalStepKind[];
  /**
   * One entry per `DeclaraApplyChange` result. `firstError` carries
   * the first failing step's error string (or undefined when all
   * steps succeeded) so tests can surface the exact dispatch error
   * instead of a terse "apply failed".
   */
  readonly appliedResults: ReadonlyArray<{
    readonly proposalId: string;
    readonly ok: boolean;
    readonly firstError?: string;
  }>;
  /**
   * Secret findings the redactor flagged on user input. Populated only
   * when `redactUserMessages` is true; the "leaked token" fixture
   * asserts this is non-empty.
   */
  readonly redactionFindings: ReadonlyArray<{ readonly label: string }>;
  /** Number of provider completions consumed. */
  readonly providerCallCount: number;
  /** Number of turns (user → assistant run). */
  readonly turnCount: number;
}

// ── Main replay entrypoint ─────────────────────────────────────────────

/**
 * Load + replay a fixture against a real {@link createEngine}. Returns
 * the captured step kinds plus bookkeeping so tests can assert the
 * full understand→propose→apply loop ran.
 */
export async function replayFixture(options: ReplayFixtureOptions): Promise<ReplayFixtureResult> {
  const entries = loadFixture(options.fixturePath);

  // Split the transcript into turns. Each turn starts with a `user`
  // entry and consumes all subsequent `assistant` entries up to (but
  // not including) the next `user` entry. That mirrors how a live
  // session works: one `runAgent` call per user message.
  interface Turn {
    readonly userText: string;
    readonly assistantResponses: LLMResponse[];
  }
  const turns: Turn[] = [];
  let cur: { userText: string; assistantResponses: LLMResponse[] } | undefined;
  const redactionFindings: Array<{ label: string }> = [];

  for (const entry of entries) {
    if (entry.role === 'user') {
      if (cur) turns.push(cur);
      let text = entry.text;
      if (options.redactUserMessages) {
        const res = redactSecrets(text);
        text = res.redacted;
        for (const f of res.findings) redactionFindings.push({ label: f.label });
      }
      cur = { userText: text, assistantResponses: [] };
    } else {
      if (!cur) {
        throw new Error(`fixture ${options.fixturePath}: assistant entry before any user entry`);
      }
      const stop =
        entry.stopReason ??
        (entry.content.some((c) => c.type === 'tool_use') ? 'tool_use' : 'end_turn');
      // Thread recorded toolResults back into the assistant content
      // stream at the tail (backlog #36). The engine's non-streaming
      // `complete()` path happily accepts `tool_result` blocks in
      // assistant content — they're pass-through for its purposes and
      // will mirror into transcript state. De-dup: don't re-append a
      // tool_result already present in `content` (covers fixtures
      // authored with both fields populated).
      const mergedContent: LLMContent[] = entry.content.slice();
      if (entry.toolResults) {
        const presentIds = new Set(
          mergedContent
            .filter((c): c is ToolResultBlock => c.type === 'tool_result')
            .map((c) => c.toolUseId),
        );
        for (const tr of entry.toolResults) {
          if (!presentIds.has(tr.toolUseId)) mergedContent.push(tr);
        }
      }
      // Surface cache-token fields when they're present so a
      // downstream test using {@link computeCacheHitRate} sees the
      // ratio we recorded rather than a zero'd fallback. The
      // `TokenUsage` shape only knows about `cacheReadTokens`, so we
      // map `cacheReadInputTokens` onto it (the canonical on-disk
      // field name) — cacheCreation is not tracked by the engine at
      // replay time and is fixture-only.
      const cacheRead = entry.usage?.cacheReadInputTokens;
      cur.assistantResponses.push({
        content: mergedContent,
        stopReason: stop,
        usage: {
          inputTokens: entry.usage?.inputTokens ?? 0,
          outputTokens: entry.usage?.outputTokens ?? 0,
          ...(typeof cacheRead === 'number' && { cacheReadTokens: cacheRead }),
        },
        model: entry.model ?? 'claude-opus-4-7',
      });
    }
  }
  if (cur) turns.push(cur);

  // Engine + tools wired exactly like the REPL would wire them, sans
  // audit sink (tests don't assert audit contents here).
  const registry = new ProposalRegistry();
  const capturedStepKinds: ProposalStepKind[] = [];
  const appliedResults: Array<{ proposalId: string; ok: boolean; firstError?: string }> = [];

  // Pre-register a summary → id auto-rejection map. Because proposal
  // ids are UUIDs minted at register time, we subscribe to `registered`
  // events and populate the set as they arrive.
  const rejectSummaryPatterns = options.rejectProposalSummaries ?? [];
  const rejectIds = new Set<string>();
  let latestProposalId: string | undefined;
  const summaryHook = registry.subscribe((event) => {
    if (event.type === 'registered') {
      latestProposalId = event.proposal.id;
      for (const pattern of rejectSummaryPatterns) {
        if (event.proposal.summary.includes(pattern)) {
          rejectIds.add(event.proposal.id);
          break;
        }
      }
    }
  });

  const unsubscribeConfirm = autoConfirmProposals(registry, rejectIds);

  const applyTool = createApplyChangeTool({
    registry,
    scopeRoot: options.scopeRoot,
  });
  const wrappedApplyTool = wrapApplyChange(
    applyTool as Tool<{ proposalId: string }, unknown>,
    registry,
    capturedStepKinds,
    appliedResults,
  );

  const tools: Tool[] = [
    createAddSkillTool({ scopeRoot: options.scopeRoot }),
    createAddSecretTool({ scopeRoot: options.scopeRoot }),
    createAddSourceTool({ scopeRoot: options.scopeRoot }),
    createAddChannelTool({ scopeRoot: options.scopeRoot }),
    createAddMCPTool({ scopeRoot: options.scopeRoot }),
    createAddPluginTool({ scopeRoot: options.scopeRoot }),
    createAuthPlaybookTool(),
    createProposeChangeTool({ registry }),
    wrappedApplyTool as Tool,
    createFleetAddTool({ scopeRoot: options.scopeRoot }),
    createAddPeerTool({ scopeRoot: options.scopeRoot }),
  ];

  // Concatenate every turn's assistant responses into one flat queue.
  // The stub provider pops from this queue every time the engine asks
  // for a completion, regardless of which turn the call came from.
  const responseQueue: LLMResponse[] = [];
  for (const turn of turns) responseQueue.push(...turn.assistantResponses);
  const provider = new RecordedProvider(responseQueue, () => latestProposalId);

  const engine = createEngine({
    provider,
    tools,
    permissions: createPermissionGate({ mode: 'bypass', rules: [] }),
  });

  const session = createReplaySession();

  for (const turn of turns) {
    if (turn.assistantResponses.length === 0) {
      throw new Error(
        `fixture ${options.fixturePath}: user turn "${turn.userText.slice(0, 40)}..." has no assistant responses; every user entry must be followed by at least one assistant entry.`,
      );
    }
    await engine.runAgent({ session, userMessage: turn.userText });
  }

  summaryHook();
  unsubscribeConfirm();

  return {
    appliedStepKinds: capturedStepKinds.slice(),
    appliedResults: appliedResults.slice(),
    redactionFindings: redactionFindings.slice(),
    providerCallCount: provider.callCount,
    turnCount: turns.length,
  };
}

// ── Cost-regression helpers (backlog #37) ──────────────────────────────

/**
 * Sum cache-read vs billable-input tokens across a fixture file's
 * assistant turns and return the ratio `cacheRead / (cacheRead +
 * inputTokens)`. Returns `null` when the fixture carries no usage
 * data at all — callers can then skip the assertion rather than
 * fail on an empty baseline.
 *
 * The denominator uses `inputTokens + cacheReadInputTokens` because
 * Anthropic's billable input tokens are the *uncached* portion; a
 * turn with 90k cache-read + 10k input means 10% of input was
 * freshly sent and 90% served from the prompt cache. A cache-hit
 * ratio below 0.8 is a useful CI alert threshold for the builder's
 * system prompt — the prompt is deliberately front-loaded with the
 * cacheable preamble.
 */
export function computeCacheHitRate(entries: readonly FixtureEntry[]): number | null {
  let totalInput = 0;
  let totalCacheRead = 0;
  let anyUsage = false;
  for (const entry of entries) {
    if (entry.role !== 'assistant') continue;
    const usage = entry.usage;
    if (!usage) continue;
    if (typeof usage.inputTokens !== 'number' && typeof usage.cacheReadInputTokens !== 'number') {
      continue;
    }
    anyUsage = true;
    totalInput += usage.inputTokens ?? 0;
    totalCacheRead += usage.cacheReadInputTokens ?? 0;
  }
  if (!anyUsage) return null;
  const denom = totalInput + totalCacheRead;
  if (denom === 0) return 0;
  return totalCacheRead / denom;
}

/**
 * Assertion helper — fails (throws) when the fixture's aggregate
 * cache-read ratio drops below `threshold`. Returns the computed
 * ratio on success so callers can additionally log / trend it.
 *
 * Use in the regression-test suite to catch silent prompt changes
 * that break cache reuse. The default threshold (0.8) reflects the
 * builder system-prompt design: the static preamble should always
 * exceed the variable portion.
 *
 * A fixture without any usage data throws a distinct error rather
 * than silently passing — "no data" is a fixture bug, not a
 * successful assertion.
 */
export function expectCacheHitRateAtLeast(fixturePath: string, threshold: number): number {
  const entries = loadFixture(fixturePath);
  const rate = computeCacheHitRate(entries);
  if (rate === null) {
    throw new Error(
      `expectCacheHitRateAtLeast: fixture ${fixturePath} has no usage data on any assistant turn — cost-regression assertion cannot run. Re-record with a provider that emits cache-token telemetry.`,
    );
  }
  if (rate < threshold) {
    const pct = (rate * 100).toFixed(1);
    const thr = (threshold * 100).toFixed(1);
    throw new Error(
      `cache-hit-rate regression in ${fixturePath}: ${pct}% observed < ${thr}% threshold. Likely cause: system-prompt edit broke the cacheable preamble's prefix stability.`,
    );
  }
  return rate;
}
