import type { AgentEvent, DispatchOutcome } from '../events/types.js';
import type { RunAgentResult, TurnContext } from '../types/agent.js';
import type { ToolCallOverride } from '../types/hooks.js';
import type { Message } from '../types/messages.js';
import type { CompletedToolCall, PendingToolCall } from '../types/tool.js';

/**
 * Skill payloads forward-declared with `unknown` so the hook layer
 * doesn't depend on slice 4's Skill module. Slice 4 will replace these
 * with concrete shapes.
 */
export interface SkillBeforePayload {
  name: string;
  inputs: Readonly<Record<string, unknown>>;
  turn: TurnContext;
}

export interface SkillAfterPayload {
  name: string;
  inputs: Readonly<Record<string, unknown>>;
  output: unknown;
  durationMs: number;
  turn: TurnContext;
}

export interface SkillBeforeOverride {
  /** Replace the skill inputs the runner sees. */
  inputs?: Readonly<Record<string, unknown>>;
}

/** Maps each hook point to the payload its subscribers receive. */
export interface HookPayloads {
  'turn.start': { turn: TurnContext };
  'turn.end': { turn: TurnContext; result: RunAgentResult };
  'tool.before': { call: PendingToolCall; turn: TurnContext };
  'tool.after': { call: CompletedToolCall; turn: TurnContext };
  'skill.before': SkillBeforePayload;
  'skill.after': SkillAfterPayload;
  'compact.before': { transcript: readonly Message[] };
  'event.before': { event: AgentEvent };
  'event.after': { event: AgentEvent; outcome: DispatchOutcome };
}

/**
 * Maps each hook point to the override (if any) a subscriber may return.
 * `undefined` means "no opinion" — the registry treats it as "continue".
 */
export interface HookReturns {
  'turn.start': undefined;
  'turn.end': undefined;
  'tool.before': ToolCallOverride | undefined;
  'tool.after': undefined;
  'skill.before': SkillBeforeOverride | undefined;
  'skill.after': undefined;
  /** Rewrite the transcript snapshot the compaction strategy sees. */
  'compact.before': { transcript: readonly Message[] } | undefined;
  /** Rewrite or drop the event before dispatch. Returning an event replaces it. */
  'event.before': { event?: AgentEvent } | undefined;
  'event.after': undefined;
}

export type HookPoint = keyof HookPayloads;

/**
 * Subscribers may be `() => {}` (sync void), `async () => {}`
 * (Promise<void>), or return an explicit override matching `HookReturns[P]`.
 * The `void` arms are intentional — they allow common subscriber shapes
 * to be assignable without an explicit `return undefined`.
 */
type MaybePromise<T> = T | Promise<T>;
// biome-ignore lint/suspicious/noConfusingVoidType: see jsdoc above.
type SubscriberReturn<P extends HookPoint> = HookReturns[P] | void;
export type HookSubscriber<P extends HookPoint> = (
  payload: HookPayloads[P],
) => MaybePromise<SubscriberReturn<P>>;

/**
 * `before`-style points short-circuit on the first non-undefined return.
 * `after`-style points always fan out to every subscriber.
 */
export const BEFORE_HOOK_POINTS: ReadonlySet<HookPoint> = new Set([
  'tool.before',
  'skill.before',
  'compact.before',
  'event.before',
]);

export function isBeforeHookPoint(point: HookPoint): boolean {
  return BEFORE_HOOK_POINTS.has(point);
}

/** Payload carried by `Extension<'hook'>` (slice 6 plugin loader registers these). */
export interface Hook<P extends HookPoint = HookPoint> {
  point: P;
  subscriber: HookSubscriber<P>;
}

export interface HookRegistry {
  /** Subscribe to a hook point. Returns an unsubscribe function. */
  on<P extends HookPoint>(point: P, subscriber: HookSubscriber<P>): () => void;
  /**
   * Fire a hook. For `before` points, returns the first non-undefined
   * subscriber return (subsequent subscribers do not run). For `after`
   * points, returns `undefined` after every subscriber has run.
   */
  fire<P extends HookPoint>(
    point: P,
    payload: HookPayloads[P],
  ): Promise<HookReturns[P] | undefined>;
  /** All currently subscribed points (for diagnostics / `/hooks` later). */
  list(): readonly HookPoint[];
  /** Number of subscribers on a given point. */
  count(point: HookPoint): number;
}
