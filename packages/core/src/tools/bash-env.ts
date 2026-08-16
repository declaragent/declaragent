/**
 * Subprocess environment scrubbing for the Bash tool.
 *
 * `Bun.spawn` without an explicit `env` inherits the daemon's entire
 * `process.env`, so a prompt-injected `printenv` (or any command that reads
 * the environment) would exfiltrate provider API keys, control-plane tokens,
 * and broker credentials held by the runtime. We pass an explicitly scrubbed
 * environment instead: secret-looking keys are removed by default, a small
 * keep-set of vars that shells genuinely need (PATH/HOME/…) always survives,
 * and operators can narrow or widen the set via allow/deny policy.
 *
 * This makes THREAT_MODEL.md's "Bash does not receive the host's secret
 * environment" claim true in code rather than aspirational.
 */

export interface BashEnvPolicy {
  /**
   * If provided, ONLY these keys (plus the always-safe keep-set) are passed to
   * the subprocess. Operators opt secrets in explicitly and at their own risk;
   * an allowlisted key passes even if it matches the secret heuristics.
   */
  allowlist?: readonly string[];
  /**
   * Extra key names (matched case-insensitively, exact) to remove on top of the
   * built-in secret heuristics.
   */
  denylist?: readonly string[];
}

/**
 * Vars a POSIX shell and common tooling need to behave; never carry secrets and
 * are always retained even in allowlist mode.
 */
export const BASH_ENV_KEEP_SET: readonly string[] = [
  'PATH',
  'HOME',
  'PWD',
  'SHELL',
  'USER',
  'LOGNAME',
  'TERM',
  'TZ',
  'LANG',
  'LC_ALL',
  'LC_CTYPE',
  'TMPDIR',
  'TMP',
  'TEMP',
  'HOSTNAME',
];

/**
 * Matches environment keys whose name (by underscore-delimited segment) signals
 * a credential. Anchored on segment boundaries to avoid false positives like
 * `PASSENGER` or `OAUTH_FLOW` (the latter is still caught when it ends in
 * `_TOKEN`/`_SECRET`).
 */
const SECRET_SEGMENT =
  /(?:^|_)(?:API[_-]?KEY|APIKEY|SECRET|TOKEN|PASSWORD|PASSWD|CREDENTIAL|CREDENTIALS|PRIVATE[_-]?KEY|ACCESS[_-]?KEY|SECRET[_-]?KEY|AUTH[_-]?TOKEN|SESSION[_-]?TOKEN|BEARER)(?:$|_)/i;

const KEEP_SET_LOWER = new Set(BASH_ENV_KEEP_SET.map((k) => k.toLowerCase()));

/** True if `key` looks like it holds a secret and should be withheld by default. */
export function looksSecret(key: string): boolean {
  return SECRET_SEGMENT.test(key);
}

/**
 * Produce a scrubbed copy of `source` suitable for handing to a subprocess.
 *
 * Default (no allowlist): every key passes EXCEPT secret-looking ones and any
 * explicit denylist entry; the keep-set is always retained.
 *
 * Allowlist mode: only the keep-set plus allowlisted keys pass; the denylist is
 * still applied on top.
 */
export function scrubBashEnv(
  source: Record<string, string | undefined>,
  policy: BashEnvPolicy = {},
): Record<string, string> {
  const allow = policy.allowlist?.length
    ? new Set(policy.allowlist.map((k) => k.toLowerCase()))
    : undefined;
  const deny = new Set((policy.denylist ?? []).map((k) => k.toLowerCase()));

  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(source)) {
    if (value === undefined) continue;
    const lower = key.toLowerCase();
    const isKept = KEEP_SET_LOWER.has(lower);

    if (deny.has(lower) && !isKept) continue;

    if (allow) {
      // Allowlist mode: keep-set + explicitly allowed keys only.
      if (!isKept && !allow.has(lower)) continue;
    } else if (!isKept && looksSecret(key)) {
      // Default mode: drop secret-looking keys.
      continue;
    }
    out[key] = value;
  }
  return out;
}

/** Parse a comma/space/colon-separated env-var list (e.g. from a config knob). */
export function parseEnvKeyList(raw: string | undefined): string[] {
  if (!raw) return [];
  return raw
    .split(/[\s,:]+/)
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}

/**
 * Resolve the Bash env policy from process-level configuration. Read once per
 * spawn so an operator can flip it without restarting in tests; cheap enough.
 */
export function resolveBashEnvPolicy(
  env: Record<string, string | undefined> = process.env,
): BashEnvPolicy {
  const allowlist = parseEnvKeyList(env.DECLARAGENT_BASH_ENV_ALLOW);
  const denylist = parseEnvKeyList(env.DECLARAGENT_BASH_ENV_DENY);
  const policy: BashEnvPolicy = {};
  if (allowlist.length > 0) policy.allowlist = allowlist;
  if (denylist.length > 0) policy.denylist = denylist;
  return policy;
}
