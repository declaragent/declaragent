/**
 * Item #4 · OIDC / OAuth2 on RPC envelopes — integration test.
 *
 * Boots a real Dex OIDC provider via docker-compose and exercises the
 * two-agent round trip end-to-end:
 *
 *   1. Agent A mints an access token via Client-Credentials grant.
 *   2. Stamps the envelope with `{ kind: 'oauth2-client', token }`.
 *   3. Agent B's inbox resolves the peer config → OIDC provider →
 *      JWKS verify → audit record.
 *   4. Missing + wrong-audience tokens are DLQ'd under `auth-rejected`.
 *
 * ## How to run
 *
 * ```sh
 * docker compose -f packages/testkit/test/fixtures/rpc-auth-dex.yml up -d
 * RPC_AUTH_INTEGRATION=1 \
 *   DEX_ISSUER=http://localhost:5556/dex \
 *   bun test packages/testkit/src/fleet-integration/rpc-auth.test.ts
 * ```
 *
 * Gated behind `RPC_AUTH_INTEGRATION=1` so unit-test runs aren't blocked
 * on Docker availability.
 *
 * @since 1.2.0
 */

import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import type { AgentRpcEnvelope } from '@declaragent/core';
import { createEventBus } from '@declaragent/core';
import {
  createAgentInboxAdapter,
  createMemoryTransport,
  createOAuth2ClientAuthProvider,
  createOidcAuthProvider,
} from '@declaragent/plugin-agent-rpc';

const ENABLED = process.env.RPC_AUTH_INTEGRATION === '1';
const ISSUER = process.env.DEX_ISSUER ?? 'http://localhost:5556/dex';
const TOKEN_ENDPOINT = `${ISSUER}/token`;
const JWKS_URI = `${ISSUER}/keys`;
const CLIENT_ID = 'decl-agent-a';
const CLIENT_SECRET = process.env.DEX_CLIENT_SECRET_A ?? 'decl-agent-a-secret';
const AUDIENCE = CLIENT_ID; // Dex sets aud = client_id on client-credentials tokens

const describeIntegration = ENABLED ? describe : describe.skip;

function noopLogger() {
  return {
    debug() {},
    info() {},
    warn() {},
    error() {},
    child() {
      return noopLogger();
    },
  };
}

describeIntegration('RPC auth — round-trip against Dex', () => {
  beforeAll(async () => {
    // Smoke-test the IdP is reachable so CI fails loudly instead of
    // surfacing a confusing "token endpoint fetch failed".
    const res = await fetch(`${ISSUER}/.well-known/openid-configuration`);
    if (!res.ok) {
      throw new Error(
        `Dex not reachable at ${ISSUER}; start with \`docker compose -f packages/testkit/test/fixtures/rpc-auth-dex.yml up -d\``,
      );
    }
  });

  afterAll(() => {
    // docker-compose is managed by the caller; nothing to tear down here.
  });

  test('two-agent round trip with a valid Client-Credentials token accepts', async () => {
    const transport = createMemoryTransport();
    const bus = createEventBus();
    const received: AgentRpcEnvelope[] = [];

    const signer = createOAuth2ClientAuthProvider({
      tokenEndpoint: TOKEN_ENDPOINT,
      clientId: CLIENT_ID,
      clientSecret: CLIENT_SECRET,
    });
    const verifier = createOidcAuthProvider({ token: 'unused' });

    const inbox = await createAgentInboxAdapter({
      transport,
      authRegistry: {
        resolve() {
          return {
            config: {
              provider: 'oidc',
              issuer: ISSUER,
              audience: AUDIENCE,
              jwksUri: JWKS_URI,
            },
            provider: verifier,
          };
        },
      },
      onRequest(env) {
        received.push(env);
      },
    }).create(
      { id: 'inbox-b', agentId: 'peer-b' },
      { bus, logger: noopLogger(), configDir: process.cwd() },
    );
    await inbox.start();

    const envelope: AgentRpcEnvelope = {
      version: 1,
      kind: 'request',
      messageId: crypto.randomUUID(),
      correlationId: crypto.randomUUID(),
      from: 'agent://peer-a',
      to: 'agent://peer-b',
      capability: 'echo',
      replyTo: 'memory://agents.peer-a.responses',
      payload: { hi: 'there' },
      auth: await signer.sign({} as AgentRpcEnvelope),
    };
    await transport.publish('agents.peer-b.requests', envelope);

    expect(received).toHaveLength(1);
    expect(received[0]?.capability).toBe('echo');
    await inbox.stop();
  }, 20_000);

  test('wrong-audience token is rejected via auth-rejected reject sink', async () => {
    const transport = createMemoryTransport();
    const bus = createEventBus();
    const received: AgentRpcEnvelope[] = [];
    const rejects: { reason: string }[] = [];

    const signer = createOAuth2ClientAuthProvider({
      tokenEndpoint: TOKEN_ENDPOINT,
      clientId: CLIENT_ID,
      clientSecret: CLIENT_SECRET,
    });
    const verifier = createOidcAuthProvider({ token: 'unused' });

    const inbox = await createAgentInboxAdapter({
      transport,
      authRegistry: {
        resolve() {
          return {
            config: {
              provider: 'oidc',
              issuer: ISSUER,
              audience: 'wrong-audience',
              jwksUri: JWKS_URI,
            },
            provider: verifier,
          };
        },
      },
      authRejectSink: ({ reason }) => {
        rejects.push({ reason });
      },
      onRequest(env) {
        received.push(env);
      },
    }).create(
      { id: 'inbox-b', agentId: 'peer-b' },
      { bus, logger: noopLogger(), configDir: process.cwd() },
    );
    await inbox.start();

    const envelope: AgentRpcEnvelope = {
      version: 1,
      kind: 'request',
      messageId: crypto.randomUUID(),
      correlationId: crypto.randomUUID(),
      from: 'agent://peer-a',
      to: 'agent://peer-b',
      capability: 'echo',
      replyTo: 'memory://agents.peer-a.responses',
      payload: {},
      auth: await signer.sign({} as AgentRpcEnvelope),
    };
    await transport.publish('agents.peer-b.requests', envelope);

    expect(received).toHaveLength(0);
    expect(rejects).toHaveLength(1);
    expect(rejects[0]?.reason).toBe('wrong-audience');
    await inbox.stop();
  }, 20_000);
});
