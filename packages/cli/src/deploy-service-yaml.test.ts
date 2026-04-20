import { describe, expect, test } from 'bun:test';
import { parse as parseYaml } from 'yaml';
import {
  extractSecretRefs,
  normalizeSecretRef,
  renderServiceYaml,
  sanitizeServiceName,
  secretRefToEnvName,
} from './deploy-service-yaml.js';

describe('sanitizeServiceName', () => {
  test('lowercases + collapses separators + trims dashes', () => {
    expect(sanitizeServiceName('Concierge Bot V2')).toBe('concierge-bot-v2');
    expect(sanitizeServiceName('__multi_tenant_starter__')).toBe('multi-tenant-starter');
    expect(sanitizeServiceName('Trailing---')).toBe('trailing');
  });

  test('caps at 49 characters and strips trailing dashes', () => {
    const long = 'a'.repeat(60);
    expect(sanitizeServiceName(long).length).toBeLessThanOrEqual(49);
  });

  test('falls back to `declaragent` when input sanitizes to empty', () => {
    expect(sanitizeServiceName('!!!')).toBe('declaragent');
  });
});

describe('normalizeSecretRef / secretRefToEnvName', () => {
  test('normalizeSecretRef is GCP-safe', () => {
    expect(normalizeSecretRef('slack/bot_token')).toBe('slack-bot-token');
    expect(normalizeSecretRef('vault:kv/data/acme/api_key')).toBe('vault-kv-data-acme-api-key');
  });

  test('secretRefToEnvName is ENV-safe SHOUTING_SNAKE', () => {
    expect(secretRefToEnvName('slack/bot_token')).toBe('SLACK_BOT_TOKEN');
    expect(secretRefToEnvName('vault:kv/data/acme/api_key')).toBe('VAULT_KV_DATA_ACME_API_KEY');
  });
});

describe('extractSecretRefs', () => {
  test('walks strings, arrays, and nested objects', () => {
    const refs = extractSecretRefs({
      channels: [
        {
          transport: { botToken: '${secret:slack/bot_token}' },
        },
      ],
      notes: 'set ${secret:vault/api_key} before running',
      nested: { deep: ['${secret:a/b}', '${env:IGNORED}'] },
    });
    expect(refs).toEqual(['slack/bot_token', 'vault/api_key', 'a/b'].sort());
  });

  test('dedupes refs mentioned multiple times', () => {
    const refs = extractSecretRefs({
      a: '${secret:x}',
      b: '${secret:x}',
      c: ['${secret:x}'],
    });
    expect(refs).toEqual(['x']);
  });

  test('returns [] when nothing matches', () => {
    expect(extractSecretRefs({ foo: 'bar', nested: [1, 2, 3] })).toEqual([]);
  });
});

describe('renderServiceYaml', () => {
  const base = {
    serviceName: 'concierge',
    project: 'my-project',
    region: 'us-central1',
    cpu: 1,
    memoryMib: 512,
    minInstances: 1,
    secretRefs: [],
    tenants: [],
  } as const;

  test('emits a parseable Knative Service doc', () => {
    const yaml = renderServiceYaml(base);
    const parsed = parseYaml(yaml) as Record<string, unknown>;
    expect(parsed.apiVersion).toBe('serving.knative.dev/v1');
    expect(parsed.kind).toBe('Service');
    expect((parsed.metadata as Record<string, unknown>).name).toBe('concierge');
  });

  test('stamps CPU + memory onto the container resources block', () => {
    const yaml = renderServiceYaml({ ...base, cpu: 2, memoryMib: 1024 });
    expect(yaml).toContain('cpu: "2"');
    expect(yaml).toContain('memory: 1024Mi');
  });

  test('annotations include minScale mirroring minInstances', () => {
    const yaml = renderServiceYaml({ ...base, minInstances: 3 });
    expect(yaml).toContain('autoscaling.knative.dev/minScale');
    // yaml serializes "3" as a quoted string
    expect(yaml).toMatch(/minScale['"]?:\s*"3"/);
  });

  test('defaults minInstances=1 — daemon stays warm for webhooks', () => {
    const yaml = renderServiceYaml(base);
    expect(yaml).toMatch(/minScale['"]?:\s*"1"/);
  });

  test('injects one env var per ${secret:...} ref, each referencing secretKeyRef', () => {
    const yaml = renderServiceYaml({
      ...base,
      secretRefs: ['slack/bot_token', 'vault/api_key'],
    });
    const parsed = parseYaml(yaml) as Record<string, unknown>;
    const container = ((parsed.spec as Record<string, unknown>).template as Record<string, unknown>)
      .spec as Record<string, unknown> as { containers: Array<Record<string, unknown>> };
    const env = container.containers[0]?.env as Array<Record<string, unknown>>;
    expect(env).toHaveLength(2);
    expect(env[0]?.name).toBe('SLACK_BOT_TOKEN');
    const ref0 = (env[0]?.valueFrom as Record<string, unknown>).secretKeyRef as Record<
      string,
      unknown
    >;
    expect(ref0.name).toBe('concierge-slack-bot-token');
    expect(ref0.key).toBe('latest');
    expect(env[1]?.name).toBe('VAULT_API_KEY');
  });

  test('emits one volume + volumeMount per tenant', () => {
    const yaml = renderServiceYaml({
      ...base,
      tenants: [{ id: 'acme-prod' }, { id: 'beta-tenant' }],
    });
    expect(yaml).toContain('/etc/declaragent/tenants/acme-prod');
    expect(yaml).toContain('/etc/declaragent/tenants/beta-tenant');
    expect(yaml).toContain('tenant-acme-prod');
    expect(yaml).toContain('tenant-beta-tenant');
  });

  test('omits env + volumes blocks entirely when nothing to bind', () => {
    const yaml = renderServiceYaml(base);
    const parsed = parseYaml(yaml) as Record<string, unknown>;
    const templateSpec = (
      (parsed.spec as Record<string, unknown>).template as Record<string, unknown>
    ).spec as Record<string, unknown>;
    expect(templateSpec.volumes).toBeUndefined();
    const container = (templateSpec.containers as Array<Record<string, unknown>>)[0];
    expect(container?.env).toBeUndefined();
    expect(container?.volumeMounts).toBeUndefined();
  });

  test('containerConcurrency is included when concurrency is set', () => {
    const yaml = renderServiceYaml({ ...base, concurrency: 8 });
    expect(yaml).toContain('containerConcurrency: 8');
  });

  test('sanitizes serviceName into metadata + image ref + secret names', () => {
    const yaml = renderServiceYaml({
      ...base,
      serviceName: 'Concierge Bot',
      project: 'myproj',
      secretRefs: ['slack/bot_token'],
    });
    expect(yaml).toContain('name: concierge-bot');
    expect(yaml).toContain('image: gcr.io/myproj/concierge-bot:latest');
    expect(yaml).toContain('name: concierge-bot-slack-bot-token');
  });
});
