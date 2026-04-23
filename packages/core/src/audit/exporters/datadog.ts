/**
 * Datadog Logs v2 intake exporter.
 *
 * Endpoint: `POST https://http-intake.logs.datadoghq.com/api/v2/logs`
 *           (override for `datadoghq.eu` / `us3` / `us5` / `ap1` via `site`).
 * Auth:     `DD-API-KEY: <api-key>` header.
 * Body:     JSON array, one log object per audit row. `ddsource`,
 *           `service`, `hostname` are set once per batch.
 *
 * Size cap: DD enforces 5 MB / batch + 1 MB / log. The exporter loop
 * batches conservatively (default 500 rows / 10s); callers pushing
 * unusually large records should shrink the batch upstream. We do not
 * auto-split here — over-limit batches surface as a 413 which the loop
 * retries, and the operator can tune `batchSize` in config.
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

/**
 * Canonical Datadog regional intake sites. Provided as a type hint only —
 * {@link CreateDatadogExporterOptions.site} is `string` so operators can
 * point at private / on-prem relays that don't match the public SaaS
 * hostnames.
 */
export type DatadogSite =
  | 'datadoghq.com'
  | 'us3.datadoghq.com'
  | 'us5.datadoghq.com'
  | 'datadoghq.eu'
  | 'ap1.datadoghq.com'
  | 'ddog-gov.com';

export interface CreateDatadogExporterOptions {
  /** Stable name for cursor tracking. Defaults to `"datadog:default"`. */
  name?: string;
  /** Datadog API key. Never logged. */
  apiKey: string;
  /** Intake site. Default `"datadoghq.com"`. Accepts any host for private deployments. */
  site?: DatadogSite | string;
  /**
   * Override the full intake URL. Takes precedence over `site`.
   * Useful for private tunnels / test mocks.
   */
  intakeUrl?: string;
  /** `service` tag. Default `"declaragent"`. */
  service?: string;
  /** `ddsource` tag. Default `"declaragent.audit"`. */
  source?: string;
  /** `hostname` field. Default — `process.env.HOSTNAME` or `"declaragent"`. */
  hostname?: string;
  /** Extra `ddtags` string (comma-separated). Default empty. */
  tags?: string;
  /** Abort the HTTP request after this many ms. Default 10_000. */
  timeoutMs?: number;
  /** Fetch injection for tests. */
  fetch?: ExporterFetch;
}

const DEFAULT_NAME = 'datadog:default';
const DEFAULT_SITE: DatadogSite = 'datadoghq.com';
const DEFAULT_SERVICE = 'declaragent';
const DEFAULT_SOURCE = 'declaragent.audit';
const DEFAULT_TIMEOUT_MS = 10_000;
const INTAKE_PATH = '/api/v2/logs';

export function createDatadogExporter(options: CreateDatadogExporterOptions): AuditExporter {
  if (!options.apiKey || options.apiKey.trim() === '') {
    throw new Error('datadog: apiKey is required');
  }

  const intakeUrl = options.intakeUrl ?? defaultIntakeUrl(options.site ?? DEFAULT_SITE);
  const apiKey = options.apiKey;
  const fetchImpl: ExporterFetch = options.fetch ?? ((input, init) => fetch(input, init));
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const envelopeDefaults = {
    service: options.service ?? DEFAULT_SERVICE,
    ddsource: options.source ?? DEFAULT_SOURCE,
    hostname: options.hostname ?? process.env.HOSTNAME ?? 'declaragent',
    ...(options.tags !== undefined && { ddtags: options.tags }),
  } as const;
  const name = options.name ?? DEFAULT_NAME;

  async function push(entries: readonly AuditExportEntry[]): Promise<PushResult> {
    if (entries.length === 0) return { ok: true, acked: 0 };
    const payload = entries.map((e) => toLogEntry(e, envelopeDefaults));
    const body = JSON.stringify(payload);

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    let response: Response;
    try {
      response = await fetchImpl(intakeUrl, {
        method: 'POST',
        headers: {
          'DD-API-KEY': apiKey,
          'Content-Type': 'application/json',
        },
        body,
        signal: controller.signal,
      });
    } catch (err) {
      clearTimeout(timer);
      const msg = err instanceof Error ? err.message : String(err);
      return { ok: false, error: `datadog: network — ${redactPath(msg)}`, retryable: true };
    }
    clearTimeout(timer);

    if (response.ok) {
      try {
        await response.text();
      } catch {
        // ignore
      }
      return { ok: true, acked: entries.length };
    }

    let detail = '';
    try {
      detail = (await response.text()).slice(0, 180);
    } catch {
      // ignore
    }
    return {
      ok: false,
      error: `datadog: http ${response.status} — ${redactPath(detail)}`,
      retryable: isRetryableHttpStatus(response.status),
    };
  }

  return { name, vendor: 'datadog', push };
}

interface DatadogLogDefaults {
  service: string;
  ddsource: string;
  hostname: string;
  ddtags?: string;
}

interface DatadogLogEntry extends DatadogLogDefaults {
  message: string;
  declaragent: {
    seq: number;
    kind: string;
    tenantId: string;
    recordHash: string;
    prevHash: string;
    ts: number;
  };
  record: Readonly<Record<string, unknown>>;
}

function toLogEntry(entry: AuditExportEntry, defaults: DatadogLogDefaults): DatadogLogEntry {
  return {
    ...defaults,
    message: `declaragent.audit.${entry.kind} tenant=${entry.tenantId} seq=${entry.seq}`,
    declaragent: {
      seq: entry.seq,
      kind: entry.kind,
      tenantId: entry.tenantId,
      recordHash: entry.recordHash,
      prevHash: entry.prevHash,
      ts: entry.ts,
    },
    record: entry.record,
  };
}

function defaultIntakeUrl(site: DatadogSite | string): string {
  return `https://http-intake.logs.${site}${INTAKE_PATH}`;
}

/**
 * Strip the intake path from any error string — defence-in-depth so
 * log ingest URLs + API key don't appear together in logs.
 */
function redactPath(text: string): string {
  return text.replaceAll(INTAKE_PATH, '<intake>');
}
