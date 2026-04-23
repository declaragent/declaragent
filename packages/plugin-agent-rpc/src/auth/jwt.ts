/**
 * Minimal JWT verification primitives. Enough to verify RS256 / RS384 /
 * RS512 / ES256 / ES384 / ES512 / PS256 / PS384 / PS512 tokens against a
 * JWKS. Deliberately pins {@link SUPPORTED_ALGS} — `alg: none`, HS*, and
 * any other asymmetric alg family must be rejected by callers.
 *
 * We roll our own instead of pulling in `jose` to avoid growing the
 * plugin's dep surface for two narrow code paths. WebCrypto is in the
 * runtime (Bun, Node ≥18) and covers every alg an OIDC IdP realistically
 * issues.
 *
 * @since 1.2.0
 */

export class JwtError extends Error {
  readonly code: string;
  constructor(code: string, message: string) {
    super(message);
    this.name = 'JwtError';
    this.code = code;
  }
}

export interface JwtHeader {
  alg: string;
  kid?: string;
  typ?: string;
  [k: string]: unknown;
}

export interface JwtClaims {
  iss?: string;
  aud?: string | string[];
  sub?: string;
  exp?: number;
  iat?: number;
  nbf?: number;
  scope?: string;
  scp?: string | string[];
  [k: string]: unknown;
}

export interface DecodedJwt {
  readonly header: JwtHeader;
  readonly claims: JwtClaims;
  readonly signingInput: string;
  readonly signature: Uint8Array;
}

/** JWKS `keys` entry — we only care about fields we consume. */
export interface JwkKey {
  kid?: string;
  kty: string;
  alg?: string;
  use?: string;
  n?: string;
  e?: string;
  crv?: string;
  x?: string;
  y?: string;
  [k: string]: unknown;
}

export const SUPPORTED_ALGS = new Set([
  'RS256',
  'RS384',
  'RS512',
  'ES256',
  'ES384',
  'ES512',
  'PS256',
  'PS384',
  'PS512',
]);

export function b64urlDecode(input: string): Uint8Array {
  // Pad + translate.
  const pad = input.length % 4 === 0 ? '' : '='.repeat(4 - (input.length % 4));
  const b64 = (input + pad).replace(/-/g, '+').replace(/_/g, '/');
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i += 1) out[i] = bin.charCodeAt(i);
  return out;
}

function decodeJson(bytes: Uint8Array): unknown {
  return JSON.parse(new TextDecoder().decode(bytes));
}

/**
 * Decode a compact JWT into its three parts. No signature verification —
 * that's {@link verifyJwtSignature}.
 */
export function decodeJwt(token: string): DecodedJwt {
  const parts = token.split('.');
  if (parts.length !== 3) {
    throw new JwtError('malformed-token', 'JWT must have three dot-separated parts');
  }
  const [hPart, cPart, sPart] = parts as [string, string, string];
  let header: JwtHeader;
  let claims: JwtClaims;
  try {
    header = decodeJson(b64urlDecode(hPart)) as JwtHeader;
    claims = decodeJson(b64urlDecode(cPart)) as JwtClaims;
  } catch (err) {
    throw new JwtError(
      'malformed-token',
      `JWT header/claims JSON decode failed: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
  if (!header || typeof header !== 'object' || typeof header.alg !== 'string') {
    throw new JwtError('malformed-token', 'JWT header missing `alg`');
  }
  const signature = b64urlDecode(sPart);
  return {
    header,
    claims,
    signingInput: `${hPart}.${cPart}`,
    signature,
  };
}

// WebCrypto param shapes. Project tsconfig's `lib` omits `dom`, so we
// inline structural typings rather than reaching for the global ones.
interface WcImportAlg {
  name: string;
  hash?: string;
  namedCurve?: string;
}
interface WcVerifyAlg {
  name: string;
  hash?: string;
  saltLength?: number;
}

function algToImport(alg: string): { importAlg: WcImportAlg; verifyAlg: WcVerifyAlg } {
  switch (alg) {
    case 'RS256':
      return {
        importAlg: { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' },
        verifyAlg: { name: 'RSASSA-PKCS1-v1_5' },
      };
    case 'RS384':
      return {
        importAlg: { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-384' },
        verifyAlg: { name: 'RSASSA-PKCS1-v1_5' },
      };
    case 'RS512':
      return {
        importAlg: { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-512' },
        verifyAlg: { name: 'RSASSA-PKCS1-v1_5' },
      };
    case 'PS256':
      return {
        importAlg: { name: 'RSA-PSS', hash: 'SHA-256' },
        verifyAlg: { name: 'RSA-PSS', saltLength: 32 },
      };
    case 'PS384':
      return {
        importAlg: { name: 'RSA-PSS', hash: 'SHA-384' },
        verifyAlg: { name: 'RSA-PSS', saltLength: 48 },
      };
    case 'PS512':
      return {
        importAlg: { name: 'RSA-PSS', hash: 'SHA-512' },
        verifyAlg: { name: 'RSA-PSS', saltLength: 64 },
      };
    case 'ES256':
      return {
        importAlg: { name: 'ECDSA', namedCurve: 'P-256' },
        verifyAlg: { name: 'ECDSA', hash: 'SHA-256' },
      };
    case 'ES384':
      return {
        importAlg: { name: 'ECDSA', namedCurve: 'P-384' },
        verifyAlg: { name: 'ECDSA', hash: 'SHA-384' },
      };
    case 'ES512':
      return {
        importAlg: { name: 'ECDSA', namedCurve: 'P-521' },
        verifyAlg: { name: 'ECDSA', hash: 'SHA-512' },
      };
    default:
      throw new JwtError('unsupported-alg', `alg "${alg}" is not supported`);
  }
}

/** Opaque handle for a WebCrypto `CryptoKey`. `lib: ES2022` omits `dom`. */
export type CryptoKeyHandle = unknown;

// WebCrypto is provided by Bun's runtime; we shim the minimal surface we
// use so the code typechecks without pulling in the `dom` lib.
interface SubtleCryptoLike {
  importKey(
    format: 'jwk',
    key: unknown,
    algorithm: unknown,
    extractable: boolean,
    keyUsages: readonly string[],
  ): Promise<CryptoKeyHandle>;
  verify(
    algorithm: unknown,
    key: CryptoKeyHandle,
    signature: Uint8Array,
    data: Uint8Array,
  ): Promise<boolean>;
}

function subtle(): SubtleCryptoLike {
  return (crypto as unknown as { subtle: SubtleCryptoLike }).subtle;
}

/**
 * Import a JWK into a WebCrypto `CryptoKey` ready for verification.
 * `alg` is the token header alg — must match the key's capabilities.
 */
export async function importJwk(key: JwkKey, alg: string): Promise<CryptoKeyHandle> {
  if (!SUPPORTED_ALGS.has(alg)) {
    throw new JwtError('unsupported-alg', `alg "${alg}" is not supported`);
  }
  const { importAlg } = algToImport(alg);
  return subtle().importKey('jwk', key, importAlg, false, ['verify']);
}

/**
 * Verify the JWT signature against `cryptoKey`. Caller is responsible for
 * selecting the right key from the JWKS based on `header.kid`.
 */
export async function verifyJwtSignature(
  decoded: DecodedJwt,
  cryptoKey: CryptoKeyHandle,
): Promise<boolean> {
  const { verifyAlg } = algToImport(decoded.header.alg);
  // WebCrypto expects ECDSA signatures as raw concatenated R||S bytes,
  // which is exactly how JWS encodes them — no conversion needed.
  const signingBytes = new TextEncoder().encode(decoded.signingInput);
  return subtle().verify(verifyAlg, cryptoKey, decoded.signature, signingBytes);
}

/**
 * Returns true when `now` is inside the JWT's validity window, respecting
 * `clockSkewSec` tolerance on both sides. `exp` and `iat` MUST be present
 * per this project's policy (RFC 7519 says `exp` is optional, but
 * enterprise IdPs always issue it and we reject tokens without it).
 */
export function checkTimeClaims(
  claims: JwtClaims,
  nowSec: number,
  clockSkewSec: number,
):
  | { ok: true }
  | { ok: false; code: 'expired' | 'not-yet-valid' | 'missing-claim'; field: string } {
  if (typeof claims.exp !== 'number') return { ok: false, code: 'missing-claim', field: 'exp' };
  if (typeof claims.iat !== 'number') return { ok: false, code: 'missing-claim', field: 'iat' };
  if (nowSec > claims.exp + clockSkewSec) {
    return { ok: false, code: 'expired', field: 'exp' };
  }
  // iat in the far future is suspicious — use clock-skew for tolerance.
  if (claims.iat > nowSec + clockSkewSec) {
    return { ok: false, code: 'not-yet-valid', field: 'iat' };
  }
  if (typeof claims.nbf === 'number' && claims.nbf > nowSec + clockSkewSec) {
    return { ok: false, code: 'not-yet-valid', field: 'nbf' };
  }
  return { ok: true };
}

export function audienceMatches(claims: JwtClaims, expected: string): boolean {
  const aud = claims.aud;
  if (typeof aud === 'string') return aud === expected;
  if (Array.isArray(aud)) return aud.includes(expected);
  return false;
}

export function extractScopes(claims: JwtClaims): string[] {
  const out: string[] = [];
  if (typeof claims.scope === 'string' && claims.scope.length > 0) {
    for (const s of claims.scope.split(/\s+/)) if (s) out.push(s);
  }
  const scp = claims.scp;
  if (typeof scp === 'string' && scp.length > 0) {
    for (const s of scp.split(/\s+/)) if (s) out.push(s);
  } else if (Array.isArray(scp)) {
    for (const s of scp) if (typeof s === 'string' && s.length > 0) out.push(s);
  }
  return out;
}
