import { stampTenantId } from '../../tenancy/stamp.js';
import type {
  AgentEvent,
  EventSourceAdapter,
  EventSourceInstance,
  EventTarget,
  SourceDependencies,
} from '../types.js';

/** One configured cron trigger. Loaded from YAML / event-sources.json. */
export interface CronTriggerConfig {
  id: string;
  /**
   * Standard 5-field cron (`"0 9 * * 1-5"`) or ISO-8601 duration
   * (`"PT5M"`). Duration is convenient shorthand for "every N minutes".
   */
  schedule: string;
  /** IANA timezone (`"America/Los_Angeles"`). Defaults to system tz. */
  timezone?: string;
  /** Where the resulting event routes. Passed straight to the dispatcher. */
  target: EventTarget;
}

/**
 * Test overrides. Production leaves both undefined and uses `Date.now` +
 * `setTimeout`. Tests swap in a virtual clock + scheduler so cron fires
 * are deterministic.
 */
export interface CronAdapterOptions {
  now?: () => number;
  scheduleTimer?: (delayMs: number, fn: () => void | Promise<void>) => () => void;
}

const DEFAULT_SCHEDULE_TIMER: NonNullable<CronAdapterOptions['scheduleTimer']> = (delayMs, fn) => {
  const t = setTimeout(() => {
    void fn();
  }, delayMs);
  return () => clearTimeout(t);
};

export function createCronAdapter(
  opts: CronAdapterOptions = {},
): EventSourceAdapter<CronTriggerConfig> {
  const now = opts.now ?? Date.now;
  const scheduleTimer = opts.scheduleTimer ?? DEFAULT_SCHEDULE_TIMER;

  return {
    type: 'cron',
    validateConfig(config: unknown): asserts config is CronTriggerConfig {
      assertTriggerConfig(config);
    },
    async create(
      config: CronTriggerConfig,
      deps: SourceDependencies,
    ): Promise<EventSourceInstance> {
      const tz = config.timezone ?? systemTimezone();
      let started = false;
      let stopped = false;
      let paused = false;
      let cancelTimer: (() => void) | null = null;
      let eventsPublished = 0;
      let lastEventAt: number | null = null;

      async function fire(): Promise<void> {
        const firedAt = now();
        eventsPublished += 1;
        lastEventAt = firedAt;
        const event: AgentEvent = {
          id: crypto.randomUUID(),
          kind: 'trigger.fire',
          source: { type: 'cron', triggerId: config.id, schedule: config.schedule },
          target: config.target,
          timestamp: firedAt,
          payload: {},
          auth: { kind: 'trigger', triggerId: config.id },
        };
        try {
          await deps.bus.publish(stampTenantId(event, deps.tenant));
        } catch (err) {
          deps.logger.warn('cron.publish.error', {
            triggerId: config.id,
            err: err instanceof Error ? err.message : String(err),
          });
        }
      }

      function scheduleNext(): void {
        if (stopped) return;
        const afterMs = now();
        let nextMs: number;
        try {
          nextMs = computeNextFire(config.schedule, afterMs, tz);
        } catch (err) {
          // Parse-time validation should have caught bad schedules; if we
          // somehow hit this at runtime, log and stop. Silent loops are
          // worse than a visible halt.
          deps.logger.error('cron.schedule.error', {
            triggerId: config.id,
            schedule: config.schedule,
            err: err instanceof Error ? err.message : String(err),
          });
          stopped = true;
          return;
        }
        const delay = Math.max(0, nextMs - afterMs);
        cancelTimer = scheduleTimer(delay, async () => {
          cancelTimer = null;
          if (stopped) return;
          if (!paused) await fire();
          scheduleNext();
        });
      }

      return {
        id: config.id,
        type: 'cron',
        async start() {
          if (started) return;
          started = true;
          stopped = false;
          scheduleNext();
        },
        async stop() {
          stopped = true;
          started = false;
          if (cancelTimer) {
            cancelTimer();
            cancelTimer = null;
          }
        },
        async pause() {
          paused = true;
        },
        async resume() {
          paused = false;
        },
        async health() {
          if (!started) return { status: 'degraded', details: stopped ? 'stopped' : 'not-started' };
          if (paused) return { status: 'degraded', details: 'paused' };
          return { status: 'ok' };
        },
        metrics() {
          return { eventsPublished, lastEventAt };
        },
      };
    },
  };
}

// ── Config validation ────────────────────────────────────────────────────

function assertTriggerConfig(config: unknown): asserts config is CronTriggerConfig {
  if (!config || typeof config !== 'object') {
    throw new Error('cron trigger config must be an object');
  }
  const c = config as Record<string, unknown>;
  if (typeof c.id !== 'string' || c.id.length === 0) {
    throw new Error('cron trigger config requires non-empty "id"');
  }
  if (typeof c.schedule !== 'string' || c.schedule.length === 0) {
    throw new Error('cron trigger config requires non-empty "schedule"');
  }
  if (c.timezone !== undefined && typeof c.timezone !== 'string') {
    throw new Error('cron trigger config "timezone" must be a string if provided');
  }
  if (!c.target || typeof c.target !== 'object') {
    throw new Error('cron trigger config requires an object "target"');
  }
  // Parse the schedule now so the host fails fast; the dispatcher
  // re-validates target shape when routing.
  validateSchedule(c.schedule);
}

/** Throws if the schedule is neither a valid PT duration nor a valid 5-field cron. */
export function validateSchedule(schedule: string): void {
  if (isDuration(schedule)) {
    parseDuration(schedule);
    return;
  }
  parseCron(schedule);
}

// ── Schedule parsing ─────────────────────────────────────────────────────

const DURATION_RE = /^PT(?:(\d+(?:\.\d+)?)H)?(?:(\d+(?:\.\d+)?)M)?(?:(\d+(?:\.\d+)?)S)?$/i;

export function isDuration(s: string): boolean {
  return /^PT/i.test(s.trim());
}

export function parseDuration(s: string): number {
  const m = s.trim().match(DURATION_RE);
  if (!m || (!m[1] && !m[2] && !m[3])) {
    throw new Error(`invalid ISO-8601 duration: "${s}"`);
  }
  const h = Number.parseFloat(m[1] ?? '0');
  const min = Number.parseFloat(m[2] ?? '0');
  const sec = Number.parseFloat(m[3] ?? '0');
  const ms = Math.round(h * 3_600_000 + min * 60_000 + sec * 1000);
  if (ms <= 0) throw new Error(`duration "${s}" resolves to non-positive interval`);
  return ms;
}

const MONTH_NAMES: Readonly<Record<string, number>> = {
  jan: 1,
  feb: 2,
  mar: 3,
  apr: 4,
  may: 5,
  jun: 6,
  jul: 7,
  aug: 8,
  sep: 9,
  oct: 10,
  nov: 11,
  dec: 12,
};

const DAY_NAMES: Readonly<Record<string, number>> = {
  sun: 0,
  mon: 1,
  tue: 2,
  wed: 3,
  thu: 4,
  fri: 5,
  sat: 6,
};

export interface CronFields {
  minute: ReadonlySet<number>;
  hour: ReadonlySet<number>;
  dayOfMonth: ReadonlySet<number>;
  month: ReadonlySet<number>;
  dayOfWeek: ReadonlySet<number>;
  /** True iff the raw DoM field was not `*` — affects OR semantics with DoW. */
  hasDomRestriction: boolean;
  hasDowRestriction: boolean;
}

export function parseCron(expr: string): CronFields {
  const parts = expr.trim().split(/\s+/);
  if (parts.length !== 5) {
    throw new Error(`cron: expected 5 fields, got ${parts.length}: "${expr}"`);
  }
  const [minuteF, hourF, domF, monthF, dowF] = parts as [string, string, string, string, string];
  return {
    minute: parseField(minuteF, 0, 59),
    hour: parseField(hourF, 0, 23),
    dayOfMonth: parseField(domF, 1, 31),
    month: parseField(monthF, 1, 12, { aliases: MONTH_NAMES }),
    dayOfWeek: parseField(dowF, 0, 6, { aliases: DAY_NAMES, sevenIsSunday: true }),
    hasDomRestriction: domF !== '*',
    hasDowRestriction: dowF !== '*',
  };
}

interface ParseFieldOpts {
  aliases?: Readonly<Record<string, number>>;
  sevenIsSunday?: boolean;
}

function parseField(s: string, lo: number, hi: number, opts: ParseFieldOpts = {}): Set<number> {
  const out = new Set<number>();
  for (const piece of s.split(',')) {
    let rest = piece;
    let stepStr: string | undefined;
    const slash = rest.indexOf('/');
    if (slash >= 0) {
      stepStr = rest.slice(slash + 1);
      rest = rest.slice(0, slash);
    }
    const step = stepStr !== undefined ? Number.parseInt(stepStr, 10) : 1;
    if (!Number.isInteger(step) || step <= 0) {
      throw new Error(`cron: invalid step "${stepStr}" in "${s}"`);
    }

    let rangeLo: number;
    let rangeHi: number;
    if (rest === '*' || rest === '') {
      rangeLo = lo;
      rangeHi = hi;
    } else if (rest.includes('-')) {
      const dash = rest.indexOf('-');
      rangeLo = parseOne(rest.slice(0, dash), lo, hi, opts);
      rangeHi = parseOne(rest.slice(dash + 1), lo, hi, opts);
    } else {
      rangeLo = parseOne(rest, lo, hi, opts);
      rangeHi = stepStr !== undefined ? hi : rangeLo;
    }

    if (rangeLo > rangeHi) {
      throw new Error(`cron: invalid range ${rangeLo}-${rangeHi} in "${s}"`);
    }
    for (let v = rangeLo; v <= rangeHi; v += step) out.add(v);
  }
  if (out.size === 0) throw new Error(`cron: field "${s}" matches no values`);
  return out;
}

function parseOne(raw: string, lo: number, hi: number, opts: ParseFieldOpts): number {
  const token = raw.toLowerCase();
  if (opts.aliases && token in opts.aliases) {
    return opts.aliases[token] as number;
  }
  const n = Number.parseInt(raw, 10);
  if (!Number.isFinite(n)) throw new Error(`cron: invalid token "${raw}"`);
  if (opts.sevenIsSunday && n === 7) return 0;
  if (n < lo || n > hi) throw new Error(`cron: value ${n} out of range ${lo}-${hi}`);
  return n;
}

// ── Next-fire computation ────────────────────────────────────────────────

/**
 * Millisecond UTC timestamp of the next fire after `afterMs`.
 * For durations, this is a simple add; for cron, a minute-by-minute
 * walk through local time in `tz`.
 *
 * Known limitation: during a DST spring-forward, a local minute that
 * doesn't exist (e.g. 02:30 on transition day) is silently skipped —
 * no fire happens. During fall-back, a repeated local minute will fire
 * once (the second occurrence is treated as distinct UTC time and we
 * land in the first pass). This matches most cron implementations.
 */
export function computeNextFire(schedule: string, afterMs: number, tz: string): number {
  if (isDuration(schedule)) {
    return afterMs + parseDuration(schedule);
  }
  return nextCronFire(parseCron(schedule), afterMs, tz);
}

const OFFSET_RE = /GMT([+-])(\d{1,2}):?(\d{0,2})/;

function getTimezoneOffsetMinutes(tz: string, utcMs: number): number {
  try {
    const fmt = new Intl.DateTimeFormat('en-US', {
      timeZone: tz,
      timeZoneName: 'longOffset',
    });
    const parts = fmt.formatToParts(new Date(utcMs));
    const tzName = parts.find((p) => p.type === 'timeZoneName')?.value ?? 'GMT';
    const m = tzName.match(OFFSET_RE);
    if (!m) return 0; // "GMT" alone means zero offset.
    const sign = m[1] === '-' ? -1 : 1;
    const hours = Number.parseInt(m[2] ?? '0', 10);
    const minutes = Number.parseInt(m[3] || '0', 10);
    return sign * (hours * 60 + minutes);
  } catch {
    // Unknown tz — caller should have validated the name. Falling back to
    // zero offset is the least-bad default: fires happen in UTC.
    return 0;
  }
}

function nextCronFire(fields: CronFields, afterMs: number, tz: string): number {
  const startOffsetMin = getTimezoneOffsetMinutes(tz, afterMs);
  // "Local ms" is what `new Date(localMs).getUTC*()` yields as local fields.
  let localMs = afterMs + startOffsetMin * 60_000;
  // Advance to the next whole-minute boundary.
  localMs = localMs - (localMs % 60_000) + 60_000;

  // 4-year cap covers the leap-year-only "0 0 29 2 *" case.
  const MAX_ITER = 4 * 366 * 24 * 60;
  for (let i = 0; i < MAX_ITER; i += 1) {
    const d = new Date(localMs);
    const minute = d.getUTCMinutes();
    const hour = d.getUTCHours();
    const dayOfMonth = d.getUTCDate();
    const month = d.getUTCMonth() + 1;
    const dayOfWeek = d.getUTCDay();

    if (
      fields.minute.has(minute) &&
      fields.hour.has(hour) &&
      fields.month.has(month) &&
      matchesDay(fields, dayOfMonth, dayOfWeek)
    ) {
      // Convert the local-time match back to UTC using the tz offset at
      // the candidate moment (which may differ from startOffsetMin if a
      // DST boundary was crossed).
      const estimateUtc = localMs - startOffsetMin * 60_000;
      const candidateOffsetMin = getTimezoneOffsetMinutes(tz, estimateUtc);
      return localMs - candidateOffsetMin * 60_000;
    }
    localMs += 60_000;
  }
  throw new Error('cron: no next fire found within 4 years');
}

function matchesDay(fields: CronFields, dom: number, dow: number): boolean {
  // Cron semantics: DoM and DoW are OR'd when BOTH are restricted, ANDed
  // via "no restriction" when one is `*`.
  if (fields.hasDomRestriction && fields.hasDowRestriction) {
    return fields.dayOfMonth.has(dom) || fields.dayOfWeek.has(dow);
  }
  if (fields.hasDomRestriction) return fields.dayOfMonth.has(dom);
  if (fields.hasDowRestriction) return fields.dayOfWeek.has(dow);
  return true;
}

function systemTimezone(): string {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';
  } catch {
    return 'UTC';
  }
}
