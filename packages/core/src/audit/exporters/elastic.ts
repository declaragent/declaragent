/**
 * Elasticsearch bulk ingest exporter.
 *
 * Endpoint: `POST <baseUrl>/<index>/_bulk`
 * Auth:     `Authorization: ApiKey <base64(apiKey)>` | `Basic <base64(user:pass)>` |
 *           `Authorization: Bearer <token>` depending on `auth.kind`.
 * Body:     NDJSON pairs — one `{"index":{"_id":"..."}}` action line
 *           followed by one source document per audit row.
 *
 * Partial-success handling: `_bulk` returns `200 {errors: true, items: [...]}`
 * when some rows indexed + others failed. We scan `items[]` in order
 * and advance the cursor only up to the first failing entry — matches
 * the contract documented on `AuditExporter.push` (return the number
 * of leading successes and let the loop retry the tail).
 *
 * @since 0.6.x — Enterprise Production Plan §3 Item #10
 */

import {
  type AuditExportEntry,
  type AuditExporter,
  type ExporterFetch,
  type PushResult,
  isRetryableHttpStatus,
} from './exporter.js';

export type ElasticAuth =
  | { kind: 'apiKey'; apiKey: string }
  | { kind: 'basic'; username: string; password: string }
  | { kind: 'bearer'; token: string };

export interface CreateElasticExporterOptions {
  /** Stable name for cursor tracking. Defaults to `"elastic:default"`. */
  name?: string;
  /** Base URL — e.g. `https://es.acme.com:9200`. No trailing slash. */
  baseUrl: string;
  /** Target index name. Default `"declaragent-audit"`. */
  index?: string;
  /** Auth block. See {@link ElasticAuth}. */
  auth: ElasticAuth;
  /** Abort the HTTP request after this many ms. Default 10_000. */
  timeoutMs?: number;
  /** Fetch injection for tests. */
  fetch?: ExporterFetch;
}

const DEFAULT_NAME = 'elastic:default';
const DEFAULT_INDEX = 'declaragent-audit';
const DEFAULT_TIMEOUT_MS = 10_000;

export function createElasticExporter(options: CreateElasticExporterOptions): AuditExporter {
  if (!options.baseUrl || options.baseUrl.trim() === '') {
    throw new Error('elastic: baseUrl is required');
  }
  validateAuth(options.auth);
  const baseUrl = options.baseUrl.trim().replace(/\/+$/, '');
  const index = options.index ?? DEFAULT_INDEX;
  const endpoint = `${baseUrl}/${encodeURIComponent(index)}/_bulk`;
  const fetchImpl: ExporterFetch = options.fetch ?? ((input, init) => fetch(input, init));
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const authHeader = buildAuthHeader(options.auth);
  const name = options.name ?? DEFAULT_NAME;

  async function push(entries: readonly AuditExportEntry[]): Promise<PushResult> {
    if (entries.length === 0) return { ok: true, acked: 0 };
    // NDJSON: action line + source line, terminating newline required.
    const lines: string[] = [];
    for (const e of entries) {
      lines.push(JSON.stringify({ index: { _id: `${e.seq}` } }));
      lines.push(JSON.stringify(toSource(e)));
    }
    const body = `${lines.join('\n')}\n`;

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    let response: Response;
    try {
      response = await fetchImpl(endpoint, {
        method: 'POST',
        headers: {
          Authorization: authHeader,
          'Content-Type': 'application/x-ndjson',
        },
        body,
        signal: controller.signal,
      });
    } catch (err) {
      clearTimeout(timer);
      const msg = err instanceof Error ? err.message : String(err);
      return {
        ok: false,
        error: `elastic: network — ${redactPath(msg, index)}`,
        retryable: true,
      };
    }
    clearTimeout(timer);

    if (!response.ok) {
      let detail = '';
      try {
        detail = (await response.text()).slice(0, 180);
      } catch {
        // ignore
      }
      return {
        ok: false,
        error: `elastic: http ${response.status} — ${redactPath(detail, index)}`,
        retryable: isRetryableHttpStatus(response.status),
      };
    }

    // 200 + parse body for partial-success. Elastic uses `{errors: bool,
    // items: [{index: {status: N, error?: {...}}}, ...]}`.
    let parsed: { errors?: boolean; items?: unknown[] };
    try {
      parsed = (await response.json()) as typeof parsed;
    } catch {
      // If we can't parse the body we have to assume nothing acked —
      // safer than advancing the cursor over rows that might be lost.
      return {
        ok: false,
        error: 'elastic: http 200 but body was not JSON',
        retryable: true,
      };
    }
    if (!parsed.errors) return { ok: true, acked: entries.length };

    // Walk items — find the first failure, advance the cursor up to it.
    const items = Array.isArray(parsed.items) ? parsed.items : [];
    let acked = 0;
    let firstErrStatus: number | undefined;
    for (const item of items) {
      const action = (item as { index?: { status?: number; error?: unknown } }).index;
      if (
        action &&
        typeof action.status === 'number' &&
        action.status >= 200 &&
        action.status < 300
      ) {
        acked += 1;
        continue;
      }
      if (action && typeof action.status === 'number') firstErrStatus = action.status;
      break;
    }
    if (acked === entries.length) return { ok: true, acked };
    if (acked > 0) return { ok: true, acked };
    const retryable = firstErrStatus === undefined ? true : isRetryableHttpStatus(firstErrStatus);
    return {
      ok: false,
      error: `elastic: bulk rejected (status=${firstErrStatus ?? 'unknown'})`,
      retryable,
    };
  }

  return { name, vendor: 'elastic', push };
}

interface ElasticSource {
  '@timestamp': string;
  declaragent: {
    seq: number;
    kind: string;
    tenantId: string;
    recordHash: string;
    prevHash: string;
  };
  record: Readonly<Record<string, unknown>>;
}

function toSource(entry: AuditExportEntry): ElasticSource {
  return {
    '@timestamp': new Date(entry.ts).toISOString(),
    declaragent: {
      seq: entry.seq,
      kind: entry.kind,
      tenantId: entry.tenantId,
      recordHash: entry.recordHash,
      prevHash: entry.prevHash,
    },
    record: entry.record,
  };
}

function validateAuth(auth: ElasticAuth): void {
  switch (auth.kind) {
    case 'apiKey':
      if (!auth.apiKey || auth.apiKey.trim() === '') throw new Error('elastic: apiKey is required');
      return;
    case 'basic':
      if (!auth.username) throw new Error('elastic: username is required');
      if (!auth.password) throw new Error('elastic: password is required');
      return;
    case 'bearer':
      if (!auth.token || auth.token.trim() === '') throw new Error('elastic: token is required');
      return;
  }
}

function buildAuthHeader(auth: ElasticAuth): string {
  switch (auth.kind) {
    case 'apiKey':
      return `ApiKey ${auth.apiKey}`;
    case 'basic': {
      const encoded = Buffer.from(`${auth.username}:${auth.password}`).toString('base64');
      return `Basic ${encoded}`;
    }
    case 'bearer':
      return `Bearer ${auth.token}`;
  }
}

/**
 * Strip the index path from any error string — if the vendor echoes
 * back the exact URL the loop tried, redact to avoid tying the
 * response to the credential used.
 */
function redactPath(text: string, index: string): string {
  return text.replaceAll(`/${index}/_bulk`, '/<index>/_bulk');
}
