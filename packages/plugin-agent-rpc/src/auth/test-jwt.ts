/**
 * Test-only helpers for minting JWTs against in-memory RSA key pairs.
 * Not part of the public surface — colocated with the auth tests but
 * scoped so it doesn't leak via the package's `index.ts` exports.
 */

interface SubtleLike {
  generateKey(
    alg: unknown,
    extractable: boolean,
    usages: readonly string[],
  ): Promise<{ publicKey: unknown; privateKey: unknown }>;
  exportKey(format: 'jwk', key: unknown): Promise<Record<string, unknown>>;
  sign(alg: unknown, key: unknown, data: Uint8Array): Promise<ArrayBuffer>;
}

function subtle(): SubtleLike {
  return (crypto as unknown as { subtle: SubtleLike }).subtle;
}

export interface TestKeyPair {
  kid: string;
  /** Public JWK with `kid` added and `alg: RS256`. */
  publicJwk: Record<string, unknown>;
  /** Private handle used by signing helpers. */
  privateKey: unknown;
}

export async function generateRs256KeyPair(kid = 'test-kid'): Promise<TestKeyPair> {
  const pair = await subtle().generateKey(
    {
      name: 'RSASSA-PKCS1-v1_5',
      modulusLength: 2048,
      publicExponent: new Uint8Array([1, 0, 1]),
      hash: 'SHA-256',
    },
    true,
    ['sign', 'verify'],
  );
  const jwk = await subtle().exportKey('jwk', pair.publicKey);
  return {
    kid,
    publicJwk: { ...jwk, kid, alg: 'RS256', use: 'sig' },
    privateKey: pair.privateKey,
  };
}

function b64url(bytes: Uint8Array | string): string {
  const u8 = typeof bytes === 'string' ? new TextEncoder().encode(bytes) : bytes;
  let s = '';
  for (let i = 0; i < u8.length; i += 1) s += String.fromCharCode(u8[i] as number);
  return btoa(s).replace(/=+$/, '').replace(/\+/g, '-').replace(/\//g, '_');
}

export interface SignJwtOptions {
  pair: TestKeyPair;
  /** If true, omits `kid` from the header. */
  omitKid?: boolean;
  /** Override the `alg` header value — useful for alg:none tests. */
  alg?: string;
  /** Emit raw signing (for alg:none). */
  emptySig?: boolean;
  claims: Record<string, unknown>;
}

export async function signJwt(options: SignJwtOptions): Promise<string> {
  const header: Record<string, unknown> = {
    alg: options.alg ?? 'RS256',
    typ: 'JWT',
  };
  if (!options.omitKid) header.kid = options.pair.kid;
  const hEnc = b64url(JSON.stringify(header));
  const cEnc = b64url(JSON.stringify(options.claims));
  const signingInput = `${hEnc}.${cEnc}`;
  if (options.emptySig) {
    return `${signingInput}.`;
  }
  const sig = await subtle().sign(
    { name: 'RSASSA-PKCS1-v1_5' },
    options.pair.privateKey,
    new TextEncoder().encode(signingInput),
  );
  return `${signingInput}.${b64url(new Uint8Array(sig))}`;
}

/**
 * Minimal fetch mock. Returns a function that matches URLs and serves
 * canned JSON. Anything unmatched throws.
 */
export function cannedFetch(
  routes: Record<
    string,
    { status?: number; body: unknown } | (() => { status?: number; body: unknown })
  >,
): typeof globalThis.fetch {
  return (async (input: unknown) => {
    const url =
      typeof input === 'string' ? input : String((input as { url?: string }).url ?? input);
    const entry = routes[url];
    if (!entry) throw new Error(`cannedFetch: no route for ${url}`);
    const resolved = typeof entry === 'function' ? entry() : entry;
    const status = resolved.status ?? 200;
    return {
      ok: status >= 200 && status < 300,
      status,
      json: async () => resolved.body,
      text: async () => JSON.stringify(resolved.body),
    } as unknown as Response;
  }) as unknown as typeof globalThis.fetch;
}
