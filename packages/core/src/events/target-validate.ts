/**
 * Shared target-validator for source adapters (webhook / cron /
 * file-watch / external brokers). Every source adapter's config
 * includes an `event.target` that eventually gets written as
 * `event.target.type` to `events.target_type NOT NULL`. Before this
 * helper existed, adapters accepted any object for `target` — a YAML
 * shape like `{ kind: skill, name: X }` (no `type` field) passed
 * adapter validation, flowed verbatim into the emitted event, and
 * tripped a silent SQLite constraint violation.
 *
 * Running this at `validateConfig` time means the misconfiguration
 * surfaces at `declaragent up` rather than at first-event-fire (where
 * the failure was invisible because the bus subscriber's default
 * logger was a NOOP).
 *
 * Keep {@link KNOWN_TARGET_TYPES} in sync with the `EventTarget` union
 * in `./types.ts`.
 *
 * @since 0.4.11
 */

export const KNOWN_TARGET_TYPES: ReadonlySet<string> = new Set([
  'session',
  'new-session',
  'skill',
  'sub-agent',
  'broadcast',
]);

/**
 * Assert that a configured target is structurally valid. Emits a
 * targeted error for the most common migration mistake: writing
 * `kind: skill` instead of `type: skill` in `event-sources.yaml`.
 */
export function assertEventTarget(value: unknown, sourceTypeLabel: string): void {
  if (!value || typeof value !== 'object') {
    throw new Error(`${sourceTypeLabel} trigger config requires an object "target"`);
  }
  const t = value as Record<string, unknown>;
  if (typeof t.type !== 'string' || t.type.length === 0) {
    if (typeof (t as { kind?: unknown }).kind === 'string') {
      throw new Error(
        `${sourceTypeLabel} target.type is required — your config uses "kind" (legacy / typo). Replace with \`type: ${String((t as { kind?: unknown }).kind)}\`.`,
      );
    }
    throw new Error(`${sourceTypeLabel} target.type must be a non-empty string`);
  }
  if (!KNOWN_TARGET_TYPES.has(t.type)) {
    throw new Error(
      `${sourceTypeLabel} target.type "${t.type}" is not a known EventTarget kind (expected one of: ${[...KNOWN_TARGET_TYPES].join(', ')})`,
    );
  }
}
