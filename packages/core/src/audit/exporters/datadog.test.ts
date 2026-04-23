/**
 * Unit + integration tests for the Datadog Logs v2 exporter.
 *
 * Integration: gated behind `DATADOG_INTEGRATION=1` plus `DD_API_KEY`.
 * Datadog doesn't distribute a local mock container, so integration
 * runs against a real free-tier account with a scoped `_not_prod`
 * API key. The test writes a single log with a unique
 * correlation string + the operator can verify ingestion manually.
 */

import { describe, expect, it } from 'bun:test';
import { createDatadogExporter } from './datadog.js';
import type { AuditExportEntry } from './exporter.js';

function sampleEntry(seq: number): AuditExportEntry {
  return {
    seq,
    ts: 1_700_000_000_000 + seq,
    kind: 'tool_call',
    tenantId: 'acme-prod',
    record: {
      kind: 'tool_call',
      ts: 1_700_000_000_000 + seq,
      tenantId: 'acme-prod',
      tool: 'Bash',
      sessionId: `s${seq}`,
      permissionKey: 'bash:exec',
      outcome: 'allow',
    },
    recordHash: String(seq).padStart(64, '0'),
    prevHash: String(seq - 1).padStart(64, '0'),
  };
}

describe('createDatadogExporter — unit', () => {
  it('POSTs a JSON array to the v2 intake with DD-API-KEY', async () => {
    let capturedUrl = '';
    let capturedBody = '';
    let capturedHeaders: Record<string, string> = {};
    const exp = createDatadogExporter({
      apiKey: 'DD-secret-api-key',
      fetch: async (url, init) => {
        capturedUrl = String(url);
        capturedBody = String(init?.body ?? '');
        capturedHeaders = (init?.headers as Record<string, string> | undefined) ?? {};
        return new Response('{}', { status: 202 });
      },
    });
    const result = await exp.push([sampleEntry(1), sampleEntry(2)]);
    expect(result).toEqual({ ok: true, acked: 2 });
    expect(capturedUrl).toBe('https://http-intake.logs.datadoghq.com/api/v2/logs');
    expect(capturedHeaders['DD-API-KEY']).toBe('DD-secret-api-key');
    const payload = JSON.parse(capturedBody) as Array<{
      declaragent?: { seq?: number };
      service?: string;
      ddsource?: string;
    }>;
    expect(payload).toHaveLength(2);
    expect(payload[0]?.service).toBe('declaragent');
    expect(payload[0]?.ddsource).toBe('declaragent.audit');
    expect(payload[0]?.declaragent?.seq).toBe(1);
  });

  it('routes to the eu site when configured', async () => {
    let url = '';
    const exp = createDatadogExporter({
      apiKey: 'k',
      site: 'datadoghq.eu',
      fetch: async (u) => {
        url = String(u);
        return new Response('', { status: 202 });
      },
    });
    await exp.push([sampleEntry(1)]);
    expect(url).toBe('https://http-intake.logs.datadoghq.eu/api/v2/logs');
  });

  it('honours an explicit intakeUrl override', async () => {
    let url = '';
    const exp = createDatadogExporter({
      apiKey: 'k',
      intakeUrl: 'http://mock-datadog.local/api/v2/logs',
      fetch: async (u) => {
        url = String(u);
        return new Response('', { status: 202 });
      },
    });
    await exp.push([sampleEntry(1)]);
    expect(url).toBe('http://mock-datadog.local/api/v2/logs');
  });

  it('flags 5xx as retryable + 400 as non-retryable', async () => {
    const s5 = createDatadogExporter({
      apiKey: 'k',
      fetch: async () => new Response('boom', { status: 502 }),
    });
    const r5 = await s5.push([sampleEntry(1)]);
    expect(r5.ok).toBe(false);
    if (!r5.ok) expect(r5.retryable).toBe(true);

    const s4 = createDatadogExporter({
      apiKey: 'k',
      fetch: async () => new Response('bad payload', { status: 400 }),
    });
    const r4 = await s4.push([sampleEntry(1)]);
    expect(r4.ok).toBe(false);
    if (!r4.ok) expect(r4.retryable).toBe(false);
  });

  it('redacts the intake path in error messages', async () => {
    const exp = createDatadogExporter({
      apiKey: 'k',
      fetch: async () => {
        throw new Error('unreachable /api/v2/logs timed out');
      },
    });
    const r = await exp.push([sampleEntry(1)]);
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.error).not.toContain('/api/v2/logs');
      expect(r.error).toContain('<intake>');
    }
  });

  it('returns acked:0 for empty batch without calling fetch', async () => {
    let called = 0;
    const exp = createDatadogExporter({
      apiKey: 'k',
      fetch: async () => {
        called += 1;
        return new Response('', { status: 202 });
      },
    });
    const r = await exp.push([]);
    expect(r).toEqual({ ok: true, acked: 0 });
    expect(called).toBe(0);
  });

  it('rejects invalid construction args', () => {
    expect(() => createDatadogExporter({ apiKey: '' })).toThrow(/apiKey/);
  });
});

describe.skipIf(process.env.DATADOG_INTEGRATION !== '1')(
  'createDatadogExporter — integration',
  () => {
    it('accepts a live payload', async () => {
      const apiKey = process.env.DD_API_KEY;
      if (!apiKey) {
        throw new Error('DD_API_KEY must be set when DATADOG_INTEGRATION=1');
      }
      const exp = createDatadogExporter({
        apiKey,
        service: 'declaragent-it',
        tags: 'env:ci,test:siem-integration',
      });
      const r = await exp.push([sampleEntry(Date.now())]);
      expect(r.ok).toBe(true);
    });
  },
);
