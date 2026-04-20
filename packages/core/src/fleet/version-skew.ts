/**
 * Fleet-version skew detection for agent-rpc envelopes.
 *
 * See FLEET_PLAN.md §8.3 for the decision matrix. In short:
 *
 *   - Producer deploys stamp `DECLARAGENT_FLEET_VERSION=v1.2.3-abc1234`.
 *   - When `fleet.yaml → rpc.stampFleetVersion: true`, every outbound
 *     request envelope carries an `x-fleet-version` header.
 *   - The receiver compares the header against its own
 *     `DECLARAGENT_FLEET_VERSION` + optional `fleet.yaml → rpc.minFleetVersion`:
 *       same                     → `match`
 *       older caller ≥ min       → `older-caller` (accept, no signal)
 *       newer caller             → `newer-caller` (accept + metric)
 *       caller < minFleetVersion → `rejected` with `EVERSION_SKEW`
 *       header missing           → `unknown`
 *
 * Helpers here are pure; wiring into the envelope + metrics pipeline
 * happens in `@declaragent/plugin-agent-rpc` (producer stamping) and
 * the receiver's inbox (consumer gating).
 *
 * @since 1.2.0
 */

import type { AgentRpcEnvelope } from '../rpc/envelope.js';

/** HTTP-style header key that carries the fleet version on the envelope. */
export const FLEET_VERSION_HEADER = 'x-fleet-version';

/**
 * Parsed form of the `v${semver}-${sha}` fleet version string. `sha` is
 * informational only — comparisons ignore it so a rolling deploy that
 * hasn't flipped the git ref yet doesn't spuriously skew.
 */
export interface ParsedFleetVersion {
  readonly raw: string;
  readonly major: number;
  readonly minor: number;
  readonly patch: number;
  readonly sha: string;
}

/**
 * Parse `vMAJOR.MINOR.PATCH-sha` into its components. Returns `undefined`
 * on a malformed string — callers treat that as "unknown / don't skew".
 *
 * Examples:
 *   `v1.2.0-a1b2c3d` → { major:1, minor:2, patch:0, sha:'a1b2c3d' }
 *   `v0.0.0-nosha`   → { major:0, minor:0, patch:0, sha:'nosha' }
 *   `1.2.0`          → undefined (no leading `v`)
 */
export function parseFleetVersion(raw: string): ParsedFleetVersion | undefined {
  const match = /^v(\d+)\.(\d+)\.(\d+)-([A-Za-z0-9]+)$/.exec(raw);
  if (!match) return undefined;
  const [, majorStr, minorStr, patchStr, sha] = match;
  const major = Number(majorStr);
  const minor = Number(minorStr);
  const patch = Number(patchStr);
  if (!Number.isFinite(major) || !Number.isFinite(minor) || !Number.isFinite(patch)) {
    return undefined;
  }
  return { raw, major, minor, patch, sha: sha ?? '' };
}

/**
 * Ordering comparator: returns negative/zero/positive per `String.localeCompare`
 * semantics when applied to (major, minor, patch). Ignores `sha`.
 */
export function compareFleetVersions(a: ParsedFleetVersion, b: ParsedFleetVersion): number {
  if (a.major !== b.major) return a.major - b.major;
  if (a.minor !== b.minor) return a.minor - b.minor;
  return a.patch - b.patch;
}

/**
 * Stamp `x-fleet-version` onto an envelope's `headers`. Returns a shallow
 * copy — the input is not mutated so producers can safely reuse a base
 * envelope across retries.
 *
 * Omitting `version` returns the envelope unchanged (caller used opt-out
 * via `fleet.yaml → rpc.stampFleetVersion: false`).
 */
export function stampFleetVersionHeader(
  envelope: AgentRpcEnvelope,
  version: string | undefined,
): AgentRpcEnvelope {
  if (!version) return envelope;
  const prev = envelope.headers ?? {};
  const headers = { ...prev, [FLEET_VERSION_HEADER]: version };
  return { ...envelope, headers };
}

/** Extract `x-fleet-version` from an envelope's headers, if present. */
export function readFleetVersionHeader(envelope: AgentRpcEnvelope): string | undefined {
  return envelope.headers?.[FLEET_VERSION_HEADER];
}

// ── Skew decision ──────────────────────────────────────────────────────

export type FleetVersionSkewStatus =
  /** Caller's header matches self (major.minor.patch equal; sha ignored). */
  | 'match'
  /** Caller is older than self but ≥ minFleetVersion — accept silently. */
  | 'older-caller'
  /** Caller is newer than self — accept + emit the `fleet.version.skew` metric. */
  | 'newer-caller'
  /** Caller < minFleetVersion — receiver rejects with EVERSION_SKEW. */
  | 'rejected'
  /**
   * No `x-fleet-version` header OR self hasn't published one (opt-out).
   * Treat as match — skew detection is opt-in and a missing header is
   * indistinguishable from an untagged caller.
   */
  | 'unknown';

export interface FleetVersionSkewInput {
  /** The caller's header (`undefined` when no header present). */
  callerVersion: string | undefined;
  /** The receiver's own version (`undefined` when `DECLARAGENT_FLEET_VERSION` unset). */
  selfVersion: string | undefined;
  /** Optional floor from `fleet.yaml → rpc.minFleetVersion`. */
  minFleetVersion?: string;
}

export interface FleetVersionSkewResult {
  status: FleetVersionSkewStatus;
  /** Parsed caller. Undefined when header is missing or malformed. */
  caller?: ParsedFleetVersion;
  /** Parsed self. Undefined when receiver didn't publish its own version. */
  self?: ParsedFleetVersion;
  /**
   * When `status: 'rejected'`, a short message suitable for the RPC
   * `RpcError.message` and the audit record. Absent otherwise.
   */
  message?: string;
}

/**
 * The receiver-side decision. Pure — no I/O, no side effects. Callers
 * (typically `agent-inbox`) emit metrics + audit records based on the
 * returned `status`.
 */
export function checkFleetVersionSkew(input: FleetVersionSkewInput): FleetVersionSkewResult {
  const callerParsed = input.callerVersion ? parseFleetVersion(input.callerVersion) : undefined;
  const selfParsed = input.selfVersion ? parseFleetVersion(input.selfVersion) : undefined;
  const minParsed = input.minFleetVersion ? parseFleetVersion(input.minFleetVersion) : undefined;

  // Hard gate first: regardless of self's version, if minFleetVersion is
  // set and the caller is older, reject. This is the operator's
  // explicit "cut off pinned-old callers" knob (§14.8).
  if (callerParsed && minParsed && compareFleetVersions(callerParsed, minParsed) < 0) {
    return {
      status: 'rejected',
      caller: callerParsed,
      ...(selfParsed !== undefined && { self: selfParsed }),
      message: `caller fleet version ${callerParsed.raw} is older than minFleetVersion ${minParsed.raw}`,
    };
  }

  // Without a caller header OR a self version, we can't compare — treat
  // as unknown. Audit logs still see the raw caller header if present.
  if (!callerParsed || !selfParsed) {
    return {
      status: 'unknown',
      ...(callerParsed !== undefined && { caller: callerParsed }),
      ...(selfParsed !== undefined && { self: selfParsed }),
    };
  }

  const cmp = compareFleetVersions(callerParsed, selfParsed);
  if (cmp === 0) return { status: 'match', caller: callerParsed, self: selfParsed };
  if (cmp < 0) return { status: 'older-caller', caller: callerParsed, self: selfParsed };
  return { status: 'newer-caller', caller: callerParsed, self: selfParsed };
}

// ── Env var contract ───────────────────────────────────────────────────

/**
 * Env var name agents read at boot to learn their own fleet version.
 * `declaragent fleet deploy` sets this on every deployed agent; the
 * in-memory deploy target surfaces it in its `lastDeployEnv` for tests.
 */
export const FLEET_VERSION_ENV = 'DECLARAGENT_FLEET_VERSION';

/** Return the fleet version from `env`, or undefined when unset. */
export function readFleetVersionFromEnv(
  env: Record<string, string | undefined> = process.env,
): string | undefined {
  const v = env[FLEET_VERSION_ENV];
  return v && v.length > 0 ? v : undefined;
}

/**
 * Return a new env map with `DECLARAGENT_FLEET_VERSION` injected. Used
 * by deploy target adapters that need to stamp the variable onto their
 * runtime env (Cloud Run, K8s, Docker Compose, etc.).
 */
export function injectFleetVersionEnv(
  env: Record<string, string>,
  version: string,
): Record<string, string> {
  return { ...env, [FLEET_VERSION_ENV]: version };
}
