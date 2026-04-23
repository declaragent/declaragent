/**
 * Unit + integration tests for the Elastic bulk exporter.
 *
 * Integration: gated behind `ELASTIC_INTEGRATION=1` (plus
 * `ELASTIC_BASE_URL`, `ELASTIC_API_KEY` or `ELASTIC_USERNAME` /
 * `ELASTIC_PASSWORD`). The CI docker-compose stack boots a single-node
 * Elasticsearch + provisions an index.
 */

import { describe, expect, it } from 'bun:test';
import { createElasticExporter } from './elastic.js';
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

describe('createElasticExporter — unit', () => {
  it('POSTs NDJSON action+source pairs to /<index>/_bulk', async () => {
    let capturedUrl = '';
    let capturedBody = '';
    let capturedAuth = '';
    const exp = createElasticExporter({
      baseUrl: 'https://es.acme.example:9200',
      index: 'declaragent-audit',
      auth: { kind: 'apiKey', apiKey: 'XYZ-api-key' },
      fetch: async (url, init) => {
        capturedUrl = String(url);
        capturedBody = String(init?.body ?? '');
        capturedAuth = (init?.headers as Record<string, string> | undefined)?.Authorization ?? '';
        return new Response(JSON.stringify({ errors: false, items: [] }), { status: 200 });
      },
    });
    const result = await exp.push([sampleEntry(1), sampleEntry(2)]);
    expect(result).toEqual({ ok: true, acked: 2 });
    expect(capturedUrl).toBe('https://es.acme.example:9200/declaragent-audit/_bulk');
    expect(capturedAuth).toBe('ApiKey XYZ-api-key');
    const lines = capturedBody.split('\n').filter((l) => l.length > 0);
    expect(lines).toHaveLength(4);
    const action = JSON.parse(lines[0] ?? '{}') as { index?: { _id: string } };
    expect(action.index?._id).toBe('1');
    const source = JSON.parse(lines[1] ?? '{}') as { '@timestamp'?: string; declaragent?: unknown };
    expect(source['@timestamp']).toBeDefined();
    expect(source.declaragent).toMatchObject({ seq: 1, tenantId: 'acme-prod' });
  });

  it('supports basic auth', async () => {
    let auth = '';
    const exp = createElasticExporter({
      baseUrl: 'https://es.acme.example:9200',
      auth: { kind: 'basic', username: 'elastic', password: 'hunter2' },
      fetch: async (_url, init) => {
        auth = (init?.headers as Record<string, string> | undefined)?.Authorization ?? '';
        return new Response('{"errors":false,"items":[]}', { status: 200 });
      },
    });
    await exp.push([sampleEntry(1)]);
    expect(auth.startsWith('Basic ')).toBe(true);
    const encoded = auth.slice('Basic '.length);
    expect(Buffer.from(encoded, 'base64').toString('utf-8')).toBe('elastic:hunter2');
  });

  it('supports bearer auth', async () => {
    let auth = '';
    const exp = createElasticExporter({
      baseUrl: 'https://es.acme.example:9200',
      auth: { kind: 'bearer', token: 'bearer-xyz' },
      fetch: async (_url, init) => {
        auth = (init?.headers as Record<string, string> | undefined)?.Authorization ?? '';
        return new Response('{"errors":false,"items":[]}', { status: 200 });
      },
    });
    await exp.push([sampleEntry(1)]);
    expect(auth).toBe('Bearer bearer-xyz');
  });

  it('advances cursor to the first failing item on partial success', async () => {
    const exp = createElasticExporter({
      baseUrl: 'https://es.acme.example:9200',
      auth: { kind: 'apiKey', apiKey: 'k' },
      fetch: async () =>
        new Response(
          JSON.stringify({
            errors: true,
            items: [
              { index: { status: 201 } },
              { index: { status: 201 } },
              { index: { status: 429, error: { type: 'throttled' } } },
              { index: { status: 201 } },
            ],
          }),
          { status: 200 },
        ),
    });
    const result = await exp.push([sampleEntry(1), sampleEntry(2), sampleEntry(3), sampleEntry(4)]);
    expect(result).toEqual({ ok: true, acked: 2 });
  });

  it('returns retryable=true when the whole batch fails with a 5xx-equivalent', async () => {
    const exp = createElasticExporter({
      baseUrl: 'https://es.acme.example:9200',
      auth: { kind: 'apiKey', apiKey: 'k' },
      fetch: async () =>
        new Response(
          JSON.stringify({
            errors: true,
            items: [{ index: { status: 503, error: { type: 'cluster_block' } } }],
          }),
          { status: 200 },
        ),
    });
    const result = await exp.push([sampleEntry(1)]);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.retryable).toBe(true);
  });

  it('flags 401 as non-retryable', async () => {
    const exp = createElasticExporter({
      baseUrl: 'https://es.acme.example:9200',
      auth: { kind: 'apiKey', apiKey: 'k' },
      fetch: async () => new Response('unauthorized', { status: 401 }),
    });
    const r = await exp.push([sampleEntry(1)]);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.retryable).toBe(false);
  });

  it('redacts the index path in error messages', async () => {
    const exp = createElasticExporter({
      baseUrl: 'https://es.acme.example:9200',
      index: 'secret-internal-audit',
      auth: { kind: 'apiKey', apiKey: 'k' },
      fetch: async () => {
        throw new Error('refused /secret-internal-audit/_bulk upstream');
      },
    });
    const r = await exp.push([sampleEntry(1)]);
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.error).not.toContain('/secret-internal-audit/_bulk');
      expect(r.error).toContain('/<index>/_bulk');
    }
  });

  it('rejects invalid construction args', () => {
    expect(() =>
      createElasticExporter({
        baseUrl: '',
        auth: { kind: 'apiKey', apiKey: 'k' },
      }),
    ).toThrow(/baseUrl/);
    expect(() =>
      createElasticExporter({
        baseUrl: 'https://x',
        auth: { kind: 'apiKey', apiKey: '' },
      }),
    ).toThrow(/apiKey/);
    expect(() =>
      createElasticExporter({
        baseUrl: 'https://x',
        auth: { kind: 'basic', username: '', password: 'p' },
      }),
    ).toThrow(/username/);
  });
});

describe.skipIf(process.env.ELASTIC_INTEGRATION !== '1')(
  'createElasticExporter — integration',
  () => {
    it('indexes against a live cluster', async () => {
      const baseUrl = process.env.ELASTIC_BASE_URL;
      const apiKey = process.env.ELASTIC_API_KEY;
      const username = process.env.ELASTIC_USERNAME;
      const password = process.env.ELASTIC_PASSWORD;
      if (!baseUrl) {
        throw new Error('ELASTIC_BASE_URL must be set when ELASTIC_INTEGRATION=1');
      }
      const auth = apiKey
        ? ({ kind: 'apiKey', apiKey } as const)
        : username && password
          ? ({ kind: 'basic', username, password } as const)
          : undefined;
      if (!auth) {
        throw new Error('ELASTIC_API_KEY or ELASTIC_USERNAME/ELASTIC_PASSWORD must be set');
      }
      const exp = createElasticExporter({ baseUrl, auth });
      const result = await exp.push([sampleEntry(Date.now())]);
      expect(result.ok).toBe(true);
    });
  },
);
