import type { LoopHooks } from '../types/hooks.js';
import type { Logger } from '../types/logger.js';
import {
  type HookPayloads,
  type HookPoint,
  type HookRegistry,
  type HookReturns,
  type HookSubscriber,
  isBeforeHookPoint,
} from './types.js';

const NOOP_LOGGER: Logger = (() => {
  const l: Logger = {
    debug() {},
    info() {},
    warn() {},
    error() {},
    child: () => l,
  };
  return l;
})();

export interface CreateHookRegistryOptions {
  logger?: Logger;
}

export function createHookRegistry(options: CreateHookRegistryOptions = {}): HookRegistry {
  const logger = options.logger ?? NOOP_LOGGER;
  // Storage is type-erased; cast through `unknown` at the boundary.
  type AnySubscriber = (payload: unknown) => unknown | Promise<unknown>;
  const subs = new Map<HookPoint, AnySubscriber[]>();

  function listFor<P extends HookPoint>(point: P): HookSubscriber<P>[] {
    return (subs.get(point) ?? []) as unknown as HookSubscriber<P>[];
  }

  return {
    on<P extends HookPoint>(point: P, subscriber: HookSubscriber<P>): () => void {
      const erased = subscriber as unknown as AnySubscriber;
      const arr = subs.get(point) ?? [];
      arr.push(erased);
      subs.set(point, arr);
      return () => {
        const cur = subs.get(point);
        if (!cur) return;
        const idx = cur.indexOf(erased);
        if (idx !== -1) cur.splice(idx, 1);
      };
    },

    async fire<P extends HookPoint>(
      point: P,
      payload: HookPayloads[P],
    ): Promise<HookReturns[P] | undefined> {
      const list = listFor(point);
      if (list.length === 0) return undefined;
      const isBefore = isBeforeHookPoint(point);
      let result: HookReturns[P] | undefined;
      for (const sub of list) {
        try {
          const r = await sub(payload);
          if (r !== undefined && result === undefined) {
            result = r;
            // Before-style: short-circuit so later subscribers don't run.
            // After-style: keep going so observers (logging, metrics) all fire.
            if (isBefore) return result;
          }
        } catch (err) {
          if (isBefore) {
            // Before hooks abort the chain; engine catches and treats as
            // a tool error so the model still sees a response.
            throw err;
          }
          // After hooks: log and keep going so one telemetry sink doesn't
          // block another.
          logger.warn('hook.after.error', { point, err: String(err) });
        }
      }
      return result;
    },

    list(): readonly HookPoint[] {
      const out: HookPoint[] = [];
      for (const [point, arr] of subs) if (arr.length > 0) out.push(point);
      return out;
    },

    count(point: HookPoint): number {
      return subs.get(point)?.length ?? 0;
    },
  };
}

/**
 * Auto-register the legacy Phase-1 `LoopHooks` callback bag onto a
 * `HookRegistry`. Returns the unsubscribe handles so callers can detach
 * the shim later. New code should subscribe directly via `registry.on`.
 */
export function bindLoopHooks(registry: HookRegistry, hooks: LoopHooks): Array<() => void> {
  const offs: Array<() => void> = [];
  if (hooks.onTurnStart) {
    offs.push(registry.on('turn.start', ({ turn }) => hooks.onTurnStart?.(turn)));
  }
  if (hooks.onTurnEnd) {
    offs.push(registry.on('turn.end', ({ turn, result }) => hooks.onTurnEnd?.(turn, result)));
  }
  if (hooks.onToolCallBefore) {
    offs.push(
      registry.on('tool.before', async ({ call }) => {
        const override = await hooks.onToolCallBefore?.(call);
        return override ?? undefined;
      }),
    );
  }
  if (hooks.onToolCallAfter) {
    offs.push(registry.on('tool.after', ({ call }) => hooks.onToolCallAfter?.(call)));
  }
  if (hooks.onCompactBefore) {
    offs.push(
      registry.on('compact.before', ({ transcript }) => {
        // LoopHooks.onCompactBefore is observation-only; ignore any return.
        void hooks.onCompactBefore?.([...transcript]);
      }),
    );
  }
  return offs;
}
