/**
 * Splunk HEC (HTTP Event Collector) exporter.
 *
 * Endpoint: `POST <hecUrl>/services/collector/event`
 * Auth:     `Authorization: Splunk <token>`
 * Body:     newline-delimited JSON, one `{event: ...}` envelope per
 *           audit row. HEC returns `200 { "code": 0, "text": "Success" }`
 *           when every event was ack'd; non-zero codes mean rejection.
 *
 * Acceptance target (§3 #10 A.1): every new audit row lands in Splunk
 * within 15s — the exporter loop pushes on a 10s interval, so the total
 * E2E latency is ~10s cursor + ~1s HTTP round-trip in the happy path.
 *
 * Redaction: neither the token nor the full URL path ever appears in
 * the returned `error` string. The host is allowed (operators already
 * know where their SIEM is); the `/services/collector/event` suffix is
 * stripped before logging.
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

export interface CreateSplunkExporterOptions {
  /** Stable name for cursor tracking. Defaults to `"splunk:default"`. */
  name?: string;
  /**
   * HEC URL. Either the bare host (`https://splunk.acme.com:8088`) or
   * the full collector path (`https://splunk.acme.com:8088/services/collector/event`);
   * the exporter normalises both.
   */
  hecUrl: string;
  /** HEC token. Never logged. */
  token: string;
  /** Override Splunk `source` field. Default `"declaragent.audit"`. */
  source?: string;
  /** Override Splunk `sourcetype` field. Default `"_json"`. */
  sourcetype?: string;
  /** Override Splunk `index` field. Default — Splunk side picks. */
  index?: string;
  /** Override Splunk `host` field. Default — pulled from `process.env.HOSTNAME` or `"declaragent"`. */
  host?: string;
  /** Abort the HTTP request after this many ms. Default 10_000. */
  timeoutMs?: number;
  /** Fetch injection for tests. */
  fetch?: ExporterFetch;
}

const DEFAULT_NAME = 'splunk:default';
const DEFAULT_SOURCE = 'declaragent.audit';
const DEFAULT_SOURCETYPE = '_json';
const DEFAULT_TIMEOUT_MS = 10_000;
const COLLECTOR_SUFFIX = '/services/collector/event';

export function createSplunkExporter(options: CreateSplunkExporterOptions): AuditExporter {
  if (!options.hecUrl || options.hecUrl.trim() === '') {
    throw new Error('splunk: hecUrl is required');
  }
  if (!options.token || options.token.trim() === '') {
    throw new Error('splunk: token is required');
  }

  const endpoint = normaliseHecUrl(options.hecUrl);
  const token = options.token;
  const fetchImpl: ExporterFetch = options.fetch ?? ((input, init) => fetch(input, init));
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const envelopeDefaults = {
    source: options.source ?? DEFAULT_SOURCE,
    sourcetype: options.sourcetype ?? DEFAULT_SOURCETYPE,
    host: options.host ?? process.env.HOSTNAME ?? 'declaragent',
    ...(options.index !== undefined && { index: options.index }),
  } as const;

  const name = options.name ?? DEFAULT_NAME;

  async function push(entries: readonly AuditExportEntry[]): Promise<PushResult> {
    if (entries.length === 0) return { ok: true, acked: 0 };
    const body = entries.map((e) => JSON.stringify(toHecEnvelope(e, envelopeDefaults))).join('\n');

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    let response: Response;
    try {
      response = await fetchImpl(endpoint, {
        method: 'POST',
        headers: {
          Authorization: `Splunk ${token}`,
          'Content-Type': 'application/json',
        },
        body,
        signal: controller.signal,
      });
    } catch (err) {
      clearTimeout(timer);
      // AbortError + network errors are always retryable — we haven't
      // proven the vendor got the bytes.
      const msg = err instanceof Error ? err.message : String(err);
      return { ok: false, error: `splunk: network — ${redactPath(msg)}`, retryable: true };
    }
    clearTimeout(timer);

    if (response.ok) {
      // Consume the body so the underlying socket isn't stranded.
      try {
        await response.text();
      } catch {
        // ignore
      }
      return { ok: true, acked: entries.length };
    }
    // Read the body once for the diagnostic string, then decide retry.
    let detail = '';
    try {
      detail = (await response.text()).slice(0, 180);
    } catch {
      // ignore
    }
    const retryable = isRetryableHttpStatus(response.status);
    return {
      ok: false,
      error: `splunk: http ${response.status} — ${redactPath(detail)}`,
      retryable,
    };
  }

  return { name, vendor: 'splunk', push };
}

interface HecEnvelopeDefaults {
  source: string;
  sourcetype: string;
  host: string;
  index?: string;
}

interface HecEnvelope {
  time: number;
  host: string;
  source: string;
  sourcetype: string;
  index?: string;
  event: {
    declaragent: {
      seq: number;
      kind: string;
      tenantId: string;
      recordHash: string;
      prevHash: string;
    };
    record: Readonly<Record<string, unknown>>;
  };
}

function toHecEnvelope(entry: AuditExportEntry, defaults: HecEnvelopeDefaults): HecEnvelope {
  // HEC accepts `time` as seconds-since-epoch (float); our ts is ms.
  const envelope: HecEnvelope = {
    time: entry.ts / 1000,
    host: defaults.host,
    source: defaults.source,
    sourcetype: defaults.sourcetype,
    event: {
      declaragent: {
        seq: entry.seq,
        kind: entry.kind,
        tenantId: entry.tenantId,
        recordHash: entry.recordHash,
        prevHash: entry.prevHash,
      },
      record: entry.record,
    },
  };
  if (defaults.index !== undefined) envelope.index = defaults.index;
  return envelope;
}

/**
 * Accept either `https://host` (bare) or `https://host/services/collector/event`
 * (full), output the canonical full URL. This saves operators from the
 * "which suffix does this CLI want?" trap.
 */
function normaliseHecUrl(raw: string): string {
  const trimmed = raw.trim().replace(/\/+$/, '');
  if (trimmed.endsWith(COLLECTOR_SUFFIX)) return trimmed;
  if (trimmed.endsWith('/services/collector')) {
    // HEC also exposes `/services/collector` — that's the batch
    // endpoint for ack=1 flows. We target the single-event endpoint.
    return `${trimmed}/event`;
  }
  return `${trimmed}${COLLECTOR_SUFFIX}`;
}

/**
 * Strip the HEC collector path from any string — defence-in-depth so
 * a copy-paste of the response body into a log line can't leak the
 * endpoint convention + token pairing to log readers.
 */
function redactPath(text: string): string {
  return text.replaceAll(COLLECTOR_SUFFIX, '<collector>');
}
