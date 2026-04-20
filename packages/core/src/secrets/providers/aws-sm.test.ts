import { describe, expect, it } from 'bun:test';
import { DEFAULT_TENANT_CONTEXT } from '../../tenancy/types.js';
import type { SecretResolveContext } from '../types.js';
import { createAwsSmProvider } from './aws-sm.js';

const ctx: SecretResolveContext = { tenant: DEFAULT_TENANT_CONTEXT, requester: 'test' };

function fakeFetch(
  handler: (url: string, init?: RequestInit) => Response | Promise<Response>,
): typeof fetch {
  const impl = async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const url =
      typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
    return await handler(url, init);
  };
  return impl as unknown as typeof fetch;
}

describe('createAwsSmProvider', () => {
  it('signs + POSTs a GetSecretValue request and returns SecretString', async () => {
    const seen: { url?: string; headers?: Record<string, string>; body?: string } = {};
    const provider = createAwsSmProvider({
      credentialsProvider: async () => ({
        accessKeyId: 'AKIA-TEST',
        secretAccessKey: 'SECRET-TEST',
      }),
      now: () => Date.parse('2026-04-18T00:00:00Z'),
      fetch: fakeFetch((url, init) => {
        seen.url = url;
        seen.headers = init?.headers as Record<string, string>;
        seen.body = typeof init?.body === 'string' ? init.body : '';
        return new Response(
          JSON.stringify({
            ARN: 'arn:aws:secretsmanager:us-east-1:0:secret:kafka-abc',
            Name: 'kafka',
            VersionId: 'v1',
            SecretString: 'shhh',
          }),
          { status: 200, headers: { 'content-type': 'application/json' } },
        );
      }),
    });
    expect(await provider.resolve('us-east-1/kafka', ctx)).toBe('shhh');
    expect(seen.url).toBe('https://secretsmanager.us-east-1.amazonaws.com/');
    expect(seen.headers?.['x-amz-target']).toBe('secretsmanager.GetSecretValue');
    expect(seen.headers?.['x-amz-date']).toBe('20260418T000000Z');
    expect(seen.headers?.authorization).toMatch(
      /^AWS4-HMAC-SHA256 Credential=AKIA-TEST\/20260418\/us-east-1\/secretsmanager\/aws4_request, SignedHeaders=content-type;host;x-amz-date;x-amz-target, Signature=[0-9a-f]{64}$/,
    );
    expect(seen.body).toBe(JSON.stringify({ SecretId: 'kafka' }));
  });

  it('extracts a JSON field via #field syntax', async () => {
    const provider = createAwsSmProvider({
      credentialsProvider: async () => ({
        accessKeyId: 'K',
        secretAccessKey: 'S',
      }),
      fetch: fakeFetch(
        () =>
          new Response(
            JSON.stringify({
              SecretString: JSON.stringify({ username: 'alice', password: 'shhh' }),
            }),
            { status: 200 },
          ),
      ),
    });
    expect(await provider.resolve('us-east-1/kafka#username', ctx)).toBe('alice');
  });

  it('includes x-amz-security-token when a session token is present', async () => {
    let headers: Record<string, string> = {};
    const provider = createAwsSmProvider({
      credentialsProvider: async () => ({
        accessKeyId: 'K',
        secretAccessKey: 'S',
        sessionToken: 'SESSION-XYZ',
      }),
      fetch: fakeFetch((_u, init) => {
        headers = init?.headers as Record<string, string>;
        return new Response(JSON.stringify({ SecretString: 'v' }), { status: 200 });
      }),
    });
    await provider.resolve('us-east-1/kafka', ctx);
    expect(headers['x-amz-security-token']).toBe('SESSION-XYZ');
    expect(headers.authorization).toContain(
      'SignedHeaders=content-type;host;x-amz-date;x-amz-security-token;x-amz-target',
    );
  });

  it('surfaces AccessDenied bodies as EDENIED', async () => {
    const provider = createAwsSmProvider({
      credentialsProvider: async () => ({ accessKeyId: 'K', secretAccessKey: 'S' }),
      fetch: fakeFetch(
        () =>
          new Response(JSON.stringify({ __type: 'AccessDeniedException', message: 'nope' }), {
            status: 400,
          }),
      ),
    });
    try {
      await provider.resolve('us-east-1/kafka', ctx);
      throw new Error('should have thrown');
    } catch (err) {
      expect((err as Error & { code?: string }).code).toBe('EDENIED');
    }
  });

  it('metadata() surfaces LastRotatedDate when present', async () => {
    const provider = createAwsSmProvider({
      credentialsProvider: async () => ({ accessKeyId: 'K', secretAccessKey: 'S' }),
      fetch: fakeFetch((_u, init) => {
        expect((init?.headers as Record<string, string>)['x-amz-target']).toBe(
          'secretsmanager.DescribeSecret',
        );
        return new Response(
          JSON.stringify({
            ARN: 'arn:aws:secretsmanager:us-east-1:0:secret:kafka',
            Name: 'kafka',
            LastRotatedDate: 1_700_000_000,
            VersionIdsToStages: { 'ver-abc': ['AWSCURRENT'] },
          }),
          { status: 200 },
        );
      }),
    });
    const meta = await provider.metadata?.('us-east-1/kafka', ctx);
    expect(meta?.lastRotatedAt).toBe(1_700_000_000_000);
    expect(meta?.version).toBe('ver-abc');
  });
});
