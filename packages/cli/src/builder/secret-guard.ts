/**
 * Secret leak detection + redaction. See BUILDER_PLAN.md §5.1.
 *
 * Pipeline per phase 2:
 *   1. User types a message into the REPL.
 *   2. `handleSubmit` in `app.tsx` runs the raw text through
 *      {@link redactSecrets} BEFORE anything hits the transcript, the
 *      engine, or the on-disk session store. The original value is
 *      discarded.
 *   3. The model sees `<redacted:label>` placeholders. A system line
 *      tells the user that a secret pattern was stripped and they
 *      should use `${env:VAR}` refs instead.
 *
 * The detectors are tight — well-known prefixes + a minimum length —
 * so false positives are rare. Missed cases are the bigger risk; new
 * patterns get appended here on demand. A `/secret ignore <snippet>`
 * slash command for false positives is a phase-6 follow-up.
 *
 * @since 0.2.0
 */

export interface SecretPattern {
  readonly re: RegExp;
  readonly label: string;
}

/**
 * §5.1 pattern list. Ordered from highest-prevalence → lowest so that
 * the first-match short-circuit in {@link detectSecret} catches the
 * common case quickly. Exporting as `readonly` so tests can enumerate
 * without risking mutation.
 */
export const SECRET_PATTERNS: readonly SecretPattern[] = [
  { re: /\bsk-(?:live|proj|ant)-[A-Za-z0-9_-]{20,}\b/g, label: 'likely API key' },
  { re: /\bghp_[A-Za-z0-9]{30,}\b/g, label: 'GitHub PAT' },
  { re: /\bgho_[A-Za-z0-9]{30,}\b/g, label: 'GitHub OAuth token' },
  { re: /\bnpm_[A-Za-z0-9]{30,}\b/g, label: 'npm token' },
  { re: /\bxox[bpoasr]-[A-Za-z0-9-]{20,}\b/g, label: 'Slack token' },
  { re: /\bAKIA[A-Z0-9]{16}\b/g, label: 'AWS access key id' },
  {
    re: /\bey[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{20,}\b/g,
    label: 'JWT',
  },
];

export interface SecretFinding {
  readonly label: string;
  /**
   * Character index in the *input* text (not the redacted text).
   * Useful for future `/secret ignore` UX; not surfaced to the model.
   */
  readonly index: number;
}

export interface RedactResult {
  readonly redacted: string;
  readonly findings: readonly SecretFinding[];
}

/**
 * Scan + redact in a single pass. The returned `findings` list has one
 * entry per match (duplicates allowed — a message that pastes two
 * GitHub PATs should surface as two findings so the user sees the
 * full count in the warning line).
 *
 * Callers that only need a yes/no answer should prefer
 * {@link detectSecret}, which short-circuits on the first match and
 * doesn't allocate a new string.
 */
export function redactSecrets(text: string): RedactResult {
  const findings: SecretFinding[] = [];
  let current = text;

  for (const { re, label } of SECRET_PATTERNS) {
    // Reset lastIndex — regexes with the global flag carry state
    // across calls, which would break idempotence otherwise.
    re.lastIndex = 0;
    current = current.replace(re, (_match: string, offset: number) => {
      findings.push({ label, index: offset });
      return `<redacted:${label}>`;
    });
  }

  return { redacted: current, findings };
}

/**
 * True iff `text` contains at least one pattern match. Returns the
 * first match's label for use in builder-tool error messages (see
 * `add-skill.ts` / `add-secret.ts`).
 *
 * Uses per-call-local RegExps so concurrent callers can't collide on
 * the `lastIndex` state of the shared exports.
 */
export function detectSecret(text: string): { label: string } | undefined {
  for (const { re, label } of SECRET_PATTERNS) {
    const local = new RegExp(re.source, re.flags.replace('g', ''));
    if (local.test(text)) return { label };
  }
  return undefined;
}

/**
 * Render a user-facing warning describing what was stripped. Used by
 * `app.tsx` to push a `system` line into the transcript right after
 * the user's redacted message. Deduplicates labels so two JWTs in one
 * message still produce a single concise line.
 */
export function formatLeakWarning(findings: readonly SecretFinding[]): string {
  if (findings.length === 0) return '';
  const labels = Array.from(new Set(findings.map((f) => f.label)));
  const listed = labels.join(', ');
  const plural = findings.length === 1 ? '' : 's';
  return `redacted ${findings.length} secret${plural} (${listed}) before the engine saw the message. Never paste credentials — use \${env:VAR} refs and put the value in .env.`;
}
