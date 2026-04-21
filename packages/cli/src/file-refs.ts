/**
 * `@<path>` file-reference expansion for REPL user messages. Matches
 * the Claude Code convention — the user says "please summarize
 * @README.md" and the CLI inlines the file contents before sending to
 * the model.
 *
 * Design:
 *   - Token regex anchors on `@` preceded by start-of-input or whitespace
 *     so prose like "[user@host.com](…)" never trips expansion.
 *   - Path chars accepted: `[A-Za-z0-9_./~\\-]`. Stops at whitespace.
 *   - Missing file: leave the token in place and surface a `missing`
 *     entry in the report so the REPL can warn the user.
 *   - Text expansion appends an "attached files" fenced block at the
 *     end of the message; the original `@ref` text is preserved so the
 *     model can correlate body prose with the attached content.
 *
 * @since 0.4.1
 */

import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { isAbsolute, resolve } from 'node:path';

/**
 * Limit each inlined attachment to ~256KB. The model rarely needs more
 * than that to answer a question, and pasting a 5MB json file would
 * trash the context window + cost dollars per request.
 */
export const MAX_ATTACHMENT_BYTES = 256 * 1024;

export interface ExpandedFileRef {
  /** Raw token as it appeared in the source, e.g. "@./README.md". */
  readonly token: string;
  /** Path as the user wrote it (without the leading `@`). */
  readonly requested: string;
  /** Fully resolved absolute path. */
  readonly resolved: string;
  /** Whether the file was successfully read + inlined. */
  readonly ok: boolean;
  /** Populated when `ok === false`. */
  readonly reason?: string;
  /** Character count of the inlined body when `ok === true`. */
  readonly bytes?: number;
  /** True if the file was truncated at {@link MAX_ATTACHMENT_BYTES}. */
  readonly truncated?: boolean;
}

export interface ExpandFileRefsResult {
  /** The original user message with an attached-files block appended. */
  readonly expanded: string;
  /** One entry per `@<path>` token found — hit or miss. */
  readonly refs: readonly ExpandedFileRef[];
}

// Leading boundary: start of string, whitespace, or a single `(` / `[`
// so mention-in-paren cases still expand. The `@` itself is captured
// inside the group so indexOf-based stitching stays simple.
const REF_PATTERN = /(^|[\s([])@([A-Za-z0-9_./~-]+)/g;

export interface ExpandFileRefsOptions {
  /** CWD for resolving relative paths. Defaults to `process.cwd()`. */
  cwd?: string;
  /** Home directory for `~` expansion. Defaults to `os.homedir()`. */
  home?: string;
  /** Size cap for each inlined file. Defaults to {@link MAX_ATTACHMENT_BYTES}. */
  maxBytes?: number;
  /**
   * File reader override — tests inject a map; production uses
   * `readFileSync` to match the sync REPL path.
   */
  read?: (resolved: string) => string;
}

export function expandFileRefs(
  text: string,
  options: ExpandFileRefsOptions = {},
): ExpandFileRefsResult {
  const cwd = options.cwd ?? process.cwd();
  const home = options.home ?? homedir();
  const maxBytes = options.maxBytes ?? MAX_ATTACHMENT_BYTES;
  const read = options.read ?? ((p: string) => readFileSync(p, 'utf8'));

  const refs: ExpandedFileRef[] = [];
  const bodies = new Map<string, string>();
  const seen = new Set<string>();

  REF_PATTERN.lastIndex = 0;
  for (const match of text.matchAll(REF_PATTERN)) {
    const requested = match[2];
    if (!requested) continue;
    if (seen.has(requested)) continue;
    seen.add(requested);

    const resolvedPath = resolvePath(requested, cwd, home);
    try {
      const raw = read(resolvedPath);
      const truncated = raw.length > maxBytes;
      const body = truncated ? raw.slice(0, maxBytes) : raw;
      bodies.set(requested, body);
      refs.push({
        token: `@${requested}`,
        requested,
        resolved: resolvedPath,
        ok: true,
        bytes: body.length,
        truncated,
      });
    } catch (err) {
      refs.push({
        token: `@${requested}`,
        requested,
        resolved: resolvedPath,
        ok: false,
        reason: err instanceof Error ? err.message : String(err),
      });
    }
  }

  const hits = refs.filter((r) => r.ok);
  if (hits.length === 0) {
    return { expanded: text, refs };
  }

  const attachments = hits
    .map((r) =>
      renderAttachment(
        r.requested,
        r.resolved,
        bodies.get(r.requested) ?? '',
        r.truncated === true,
      ),
    )
    .join('\n\n');

  const separator = text.endsWith('\n') ? '\n' : '\n\n';
  const expanded = `${text}${separator}---\nAttached files:\n\n${attachments}\n`;
  return { expanded, refs };
}

function resolvePath(requested: string, cwd: string, home: string): string {
  if (requested.startsWith('~/')) return resolve(home, requested.slice(2));
  if (requested === '~') return home;
  if (isAbsolute(requested)) return requested;
  return resolve(cwd, requested);
}

function renderAttachment(
  requested: string,
  resolvedPath: string,
  body: string,
  truncated: boolean,
): string {
  const header =
    requested === resolvedPath ? `## @${requested}` : `## @${requested} (${resolvedPath})`;
  const suffix = truncated ? `\n\n_(truncated at ${MAX_ATTACHMENT_BYTES} bytes)_` : '';
  // Fence with triple-backtick + a language guess from the extension.
  // Heavy-handed parsing isn't worth it — the model handles prose-in-
  // code-fence fine.
  const lang = languageHint(requested);
  return `${header}\n\`\`\`${lang}\n${body}\n\`\`\`${suffix}`;
}

function languageHint(path: string): string {
  const ext = path.split('.').pop()?.toLowerCase() ?? '';
  switch (ext) {
    case 'ts':
    case 'tsx':
      return 'ts';
    case 'js':
    case 'jsx':
      return 'js';
    case 'py':
      return 'python';
    case 'rs':
      return 'rust';
    case 'go':
      return 'go';
    case 'md':
    case 'markdown':
      return 'md';
    case 'yaml':
    case 'yml':
      return 'yaml';
    case 'json':
      return 'json';
    case 'sh':
    case 'bash':
      return 'bash';
    case 'html':
      return 'html';
    case 'css':
      return 'css';
    case 'sql':
      return 'sql';
    default:
      return '';
  }
}
