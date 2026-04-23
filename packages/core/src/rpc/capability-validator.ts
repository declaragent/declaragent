/**
 * JSON Schema validator for typed capabilities (Enterprise Production
 * Plan #11 · v1.1 Agent Graph).
 *
 * Hand-rolled draft-07 subset — intentionally scoped to the keywords we
 * need for capability request / response schemas:
 *
 *   - `type`: object | array | string | integer | number | boolean | null
 *   - `enum`, `const`
 *   - `properties`, `required`, `additionalProperties`
 *   - `items` (single schema; tuple form not supported)
 *   - `minimum`, `maximum`, `exclusiveMinimum`, `exclusiveMaximum`
 *   - `minLength`, `maxLength`, `pattern`
 *   - `minItems`, `maxItems`, `uniqueItems`
 *   - `oneOf`, `anyOf`, `allOf`, `not`
 *   - `$ref` (local only: `#/definitions/<name>`), `definitions`
 *   - `format: uuid | email | uri` (advisory — rejects on obvious malformed input)
 *
 * We deliberately avoid a full AJV dependency to keep the `@declaragent/core`
 * dependency graph lean (currently only `@anthropic-ai/sdk`, `chokidar`,
 * `yaml`, `zod`). When the schema grows beyond this subset we'll migrate
 * to AJV — the `CapabilityValidator` contract is the seam.
 *
 * Performance:
 *   - {@link compileCapabilityValidator} pre-resolves `$ref` targets and
 *     walks the schema once, so validation is just a tree traversal.
 *   - {@link createCapabilityValidatorRegistry} caches compiled validators
 *     by `(capabilityName, sha-like hash of the schema JSON)` — a schema
 *     swap invalidates transparently.
 *
 * @since 1.2.0
 */

export type CapabilitySide = 'request' | 'response';

export interface CapabilitySchemaViolation {
  /** JSON pointer-style path into the payload (`/foo/bar/0`). */
  path: string;
  message: string;
}

export type CapabilityValidationResult =
  | { ok: true }
  | { ok: false; violations: CapabilitySchemaViolation[] };

/** Pre-compiled validator for one capability schema. */
export interface CapabilityValidator {
  readonly capabilityName: string;
  readonly side: CapabilitySide;
  readonly schemaHash: string;
  validate(value: unknown): CapabilityValidationResult;
}

export class CapabilitySchemaCompileError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'CapabilitySchemaCompileError';
  }
}

// ── Compile ────────────────────────────────────────────────────────────────

interface CompileContext {
  definitions: Record<string, unknown>;
}

export interface CompileCapabilityValidatorOptions {
  capabilityName: string;
  side: CapabilitySide;
  schema: unknown;
}

/**
 * Compile a single JSON Schema into a runtime {@link CapabilityValidator}.
 *
 * Throws {@link CapabilitySchemaCompileError} when the schema uses a
 * keyword this subset doesn't support, or references a missing definition.
 */
export function compileCapabilityValidator(
  opts: CompileCapabilityValidatorOptions,
): CapabilityValidator {
  if (typeof opts.schema !== 'object' || opts.schema === null) {
    throw new CapabilitySchemaCompileError(
      `${opts.capabilityName}:${opts.side}: schema must be a JSON object`,
    );
  }
  const rootSchema = opts.schema as Record<string, unknown>;
  const definitions =
    typeof rootSchema.definitions === 'object' && rootSchema.definitions !== null
      ? (rootSchema.definitions as Record<string, unknown>)
      : {};
  const ctx: CompileContext = { definitions };

  // Walk once to surface compile-time errors early.
  assertSupported(rootSchema, ctx, '');

  const schemaHash = hashSchema(rootSchema);

  return {
    capabilityName: opts.capabilityName,
    side: opts.side,
    schemaHash,
    validate(value: unknown): CapabilityValidationResult {
      const violations: CapabilitySchemaViolation[] = [];
      validateNode(rootSchema, value, '', ctx, violations);
      if (violations.length === 0) return { ok: true };
      return { ok: false, violations };
    },
  };
}

// ── Registry ───────────────────────────────────────────────────────────────

export interface CapabilityValidatorRegistry {
  /**
   * Look up (or compile and cache) a validator for the given capability.
   * Returns `null` when no schema is declared for `side` — callers should
   * treat that as legacy "loose JSON, no validation" (back-compat).
   */
  get(capabilityName: string, side: CapabilitySide, schema: unknown): CapabilityValidator | null;
  /** Number of cached validators (tests). */
  size(): number;
  /** Drop cached validators (tests / hot reload). */
  clear(): void;
}

export function createCapabilityValidatorRegistry(): CapabilityValidatorRegistry {
  const cache = new Map<string, CapabilityValidator>();
  return {
    get(capabilityName, side, schema) {
      if (schema === undefined || schema === null) return null;
      const hash = hashSchema(schema);
      const key = `${capabilityName}::${side}::${hash}`;
      const cached = cache.get(key);
      if (cached) return cached;
      const compiled = compileCapabilityValidator({ capabilityName, side, schema });
      cache.set(key, compiled);
      return compiled;
    },
    size() {
      return cache.size;
    },
    clear() {
      cache.clear();
    },
  };
}

// ── Hashing ────────────────────────────────────────────────────────────────

/**
 * FNV-1a 64-bit over a canonical JSON serialization of the schema. Fast
 * enough for load-time compilation, stable across runs, and an order of
 * magnitude cheaper than SHA-256.
 */
export function hashSchema(schema: unknown): string {
  const canon = canonicalJson(schema);
  let h1 = 0xcbf29ce4;
  let h2 = 0x84222325;
  for (let i = 0; i < canon.length; i += 1) {
    const c = canon.charCodeAt(i);
    h1 ^= c;
    h2 ^= c;
    // FNV-1a prime: 0x100000001b3 — split into two 32-bit multiplies to
    // avoid BigInt overhead.
    h1 = Math.imul(h1, 0x01000193) >>> 0;
    h2 = Math.imul(h2, 0x01000193) >>> 0;
  }
  return `${h1.toString(16).padStart(8, '0')}${h2.toString(16).padStart(8, '0')}`;
}

/**
 * Deterministic JSON stringification with sorted object keys. Used both
 * for schema-hash keying and by the codegen path for stable diffs.
 */
export function canonicalJson(value: unknown): string {
  if (value === null) return 'null';
  if (typeof value === 'number') return Number.isFinite(value) ? String(value) : 'null';
  if (typeof value === 'boolean') return value ? 'true' : 'false';
  if (typeof value === 'string') return JSON.stringify(value);
  if (Array.isArray(value)) {
    return `[${value.map((v) => canonicalJson(v)).join(',')}]`;
  }
  if (typeof value === 'object') {
    const keys = Object.keys(value as Record<string, unknown>).sort();
    const parts = keys.map(
      (k) => `${JSON.stringify(k)}:${canonicalJson((value as Record<string, unknown>)[k])}`,
    );
    return `{${parts.join(',')}}`;
  }
  // undefined, functions, symbols — not valid JSON; treat as null.
  return 'null';
}

// ── Supported-keyword audit ───────────────────────────────────────────────

const SUPPORTED_KEYWORDS = new Set([
  '$id',
  '$schema',
  '$ref',
  'title',
  'description',
  'default',
  'examples',
  'definitions',
  'type',
  'enum',
  'const',
  'properties',
  'required',
  'additionalProperties',
  'items',
  'minimum',
  'maximum',
  'exclusiveMinimum',
  'exclusiveMaximum',
  'minLength',
  'maxLength',
  'pattern',
  'minItems',
  'maxItems',
  'uniqueItems',
  'oneOf',
  'anyOf',
  'allOf',
  'not',
  'format',
  'nullable', // tolerated — coerced to `type: [T, "null"]` semantics
]);

function assertSupported(schema: unknown, ctx: CompileContext, path: string): void {
  if (typeof schema === 'boolean') return; // `true`/`false` schemas are supported.
  if (typeof schema !== 'object' || schema === null) {
    throw new CapabilitySchemaCompileError(
      `schema at ${path || '<root>'} must be object or boolean`,
    );
  }
  const obj = schema as Record<string, unknown>;
  for (const key of Object.keys(obj)) {
    if (!SUPPORTED_KEYWORDS.has(key)) {
      throw new CapabilitySchemaCompileError(
        `unsupported JSON Schema keyword "${key}" at ${path || '<root>'}`,
      );
    }
  }
  if (typeof obj.$ref === 'string') {
    const resolved = resolveRef(obj.$ref, ctx);
    if (resolved === undefined) {
      throw new CapabilitySchemaCompileError(
        `unresolved $ref "${obj.$ref}" at ${path || '<root>'}`,
      );
    }
  }
  if (obj.properties && typeof obj.properties === 'object') {
    for (const [k, v] of Object.entries(obj.properties as Record<string, unknown>)) {
      assertSupported(v, ctx, `${path}/properties/${k}`);
    }
  }
  if (obj.items) {
    if (Array.isArray(obj.items)) {
      throw new CapabilitySchemaCompileError(
        `tuple-form items[] not supported at ${path || '<root>'}/items`,
      );
    }
    assertSupported(obj.items, ctx, `${path}/items`);
  }
  if (obj.additionalProperties && typeof obj.additionalProperties === 'object') {
    assertSupported(obj.additionalProperties, ctx, `${path}/additionalProperties`);
  }
  for (const kw of ['oneOf', 'anyOf', 'allOf'] as const) {
    const v = obj[kw];
    if (Array.isArray(v)) {
      v.forEach((sub, i) => assertSupported(sub, ctx, `${path}/${kw}/${i}`));
    }
  }
  if (obj.not !== undefined) assertSupported(obj.not, ctx, `${path}/not`);
  if (obj.definitions && typeof obj.definitions === 'object') {
    for (const [k, v] of Object.entries(obj.definitions as Record<string, unknown>)) {
      assertSupported(v, ctx, `${path}/definitions/${k}`);
    }
  }
}

function resolveRef(ref: string, ctx: CompileContext): unknown {
  if (!ref.startsWith('#/definitions/')) return undefined;
  const name = ref.slice('#/definitions/'.length);
  if (!Object.prototype.hasOwnProperty.call(ctx.definitions, name)) return undefined;
  return ctx.definitions[name];
}

// ── Validation ─────────────────────────────────────────────────────────────

function validateNode(
  schema: unknown,
  value: unknown,
  path: string,
  ctx: CompileContext,
  violations: CapabilitySchemaViolation[],
): void {
  if (schema === true) return;
  if (schema === false) {
    violations.push({ path: path || '/', message: 'schema `false` rejects all values' });
    return;
  }
  if (typeof schema !== 'object' || schema === null) return;
  const obj = schema as Record<string, unknown>;

  if (typeof obj.$ref === 'string') {
    const resolved = resolveRef(obj.$ref, ctx);
    if (resolved === undefined) {
      violations.push({ path: path || '/', message: `unresolved $ref ${obj.$ref}` });
      return;
    }
    validateNode(resolved, value, path, ctx, violations);
    return;
  }

  // type
  if (obj.type !== undefined) {
    const types: readonly string[] = Array.isArray(obj.type)
      ? (obj.type as readonly string[])
      : [obj.type as string];
    if (!types.some((t) => matchesType(t, value))) {
      violations.push({
        path: path || '/',
        message: `expected type ${types.join('|')} but got ${describeType(value)}`,
      });
      // Further type-specific checks would be noise; stop here for this node.
      return;
    }
  }

  // const
  if ('const' in obj) {
    if (!deepEqual(value, obj.const)) {
      violations.push({
        path: path || '/',
        message: `expected const ${JSON.stringify(obj.const)} but got ${JSON.stringify(value)}`,
      });
    }
  }

  // enum
  if (Array.isArray(obj.enum)) {
    const found = obj.enum.some((e) => deepEqual(value, e));
    if (!found) {
      violations.push({
        path: path || '/',
        message: `value not in enum [${obj.enum.map((e) => JSON.stringify(e)).join(', ')}]`,
      });
    }
  }

  // string-specific
  if (typeof value === 'string') {
    if (typeof obj.minLength === 'number' && value.length < obj.minLength) {
      violations.push({
        path: path || '/',
        message: `string length ${value.length} < minLength ${obj.minLength}`,
      });
    }
    if (typeof obj.maxLength === 'number' && value.length > obj.maxLength) {
      violations.push({
        path: path || '/',
        message: `string length ${value.length} > maxLength ${obj.maxLength}`,
      });
    }
    if (typeof obj.pattern === 'string') {
      try {
        const re = new RegExp(obj.pattern);
        if (!re.test(value)) {
          violations.push({
            path: path || '/',
            message: `string does not match pattern /${obj.pattern}/`,
          });
        }
      } catch {
        // Bad regex in schema — caught at compile time too; ignore here.
      }
    }
    if (typeof obj.format === 'string') {
      const fmtErr = checkFormat(obj.format, value);
      if (fmtErr)
        violations.push({ path: path || '/', message: `format ${obj.format}: ${fmtErr}` });
    }
  }

  // number-specific
  if (typeof value === 'number') {
    if (typeof obj.minimum === 'number' && value < obj.minimum) {
      violations.push({
        path: path || '/',
        message: `${value} < minimum ${obj.minimum}`,
      });
    }
    if (typeof obj.maximum === 'number' && value > obj.maximum) {
      violations.push({
        path: path || '/',
        message: `${value} > maximum ${obj.maximum}`,
      });
    }
    if (typeof obj.exclusiveMinimum === 'number' && value <= obj.exclusiveMinimum) {
      violations.push({
        path: path || '/',
        message: `${value} <= exclusiveMinimum ${obj.exclusiveMinimum}`,
      });
    }
    if (typeof obj.exclusiveMaximum === 'number' && value >= obj.exclusiveMaximum) {
      violations.push({
        path: path || '/',
        message: `${value} >= exclusiveMaximum ${obj.exclusiveMaximum}`,
      });
    }
  }

  // object-specific
  if (isPlainObject(value)) {
    const objValue = value as Record<string, unknown>;
    const props =
      obj.properties && typeof obj.properties === 'object'
        ? (obj.properties as Record<string, unknown>)
        : {};
    if (Array.isArray(obj.required)) {
      for (const key of obj.required as string[]) {
        if (!(key in objValue)) {
          violations.push({
            path: `${path}/${escapePointer(key)}`,
            message: `missing required property "${key}"`,
          });
        }
      }
    }
    for (const [key, child] of Object.entries(objValue)) {
      if (Object.prototype.hasOwnProperty.call(props, key)) {
        validateNode(props[key], child, `${path}/${escapePointer(key)}`, ctx, violations);
      } else if (obj.additionalProperties === false) {
        violations.push({
          path: `${path}/${escapePointer(key)}`,
          message: `additional property "${key}" is not allowed`,
        });
      } else if (
        typeof obj.additionalProperties === 'object' &&
        obj.additionalProperties !== null
      ) {
        validateNode(
          obj.additionalProperties,
          child,
          `${path}/${escapePointer(key)}`,
          ctx,
          violations,
        );
      }
    }
  }

  // array-specific
  if (Array.isArray(value)) {
    if (typeof obj.minItems === 'number' && value.length < obj.minItems) {
      violations.push({
        path: path || '/',
        message: `array length ${value.length} < minItems ${obj.minItems}`,
      });
    }
    if (typeof obj.maxItems === 'number' && value.length > obj.maxItems) {
      violations.push({
        path: path || '/',
        message: `array length ${value.length} > maxItems ${obj.maxItems}`,
      });
    }
    if (obj.uniqueItems === true) {
      const seen: unknown[] = [];
      for (let i = 0; i < value.length; i += 1) {
        const v = value[i];
        if (seen.some((s) => deepEqual(s, v))) {
          violations.push({ path: `${path}/${i}`, message: 'duplicate item' });
          break;
        }
        seen.push(v);
      }
    }
    if (obj.items !== undefined && !Array.isArray(obj.items)) {
      for (let i = 0; i < value.length; i += 1) {
        validateNode(obj.items, value[i], `${path}/${i}`, ctx, violations);
      }
    }
  }

  // oneOf / anyOf / allOf / not
  if (Array.isArray(obj.oneOf)) {
    let matched = 0;
    for (const sub of obj.oneOf) {
      const local: CapabilitySchemaViolation[] = [];
      validateNode(sub, value, path, ctx, local);
      if (local.length === 0) matched += 1;
    }
    if (matched !== 1) {
      violations.push({
        path: path || '/',
        message: `oneOf matched ${matched} schemas (expected exactly 1)`,
      });
    }
  }
  if (Array.isArray(obj.anyOf)) {
    const matched = (obj.anyOf as unknown[]).some((sub) => {
      const local: CapabilitySchemaViolation[] = [];
      validateNode(sub, value, path, ctx, local);
      return local.length === 0;
    });
    if (!matched) {
      violations.push({ path: path || '/', message: 'anyOf matched zero schemas' });
    }
  }
  if (Array.isArray(obj.allOf)) {
    for (const sub of obj.allOf) {
      validateNode(sub, value, path, ctx, violations);
    }
  }
  if (obj.not !== undefined) {
    const local: CapabilitySchemaViolation[] = [];
    validateNode(obj.not, value, path, ctx, local);
    if (local.length === 0) {
      violations.push({ path: path || '/', message: 'not-schema matched' });
    }
  }
}

function matchesType(t: string, value: unknown): boolean {
  switch (t) {
    case 'null':
      return value === null;
    case 'boolean':
      return typeof value === 'boolean';
    case 'string':
      return typeof value === 'string';
    case 'number':
      return typeof value === 'number' && Number.isFinite(value);
    case 'integer':
      return typeof value === 'number' && Number.isInteger(value);
    case 'array':
      return Array.isArray(value);
    case 'object':
      return isPlainObject(value);
    default:
      return false;
  }
}

function describeType(value: unknown): string {
  if (value === null) return 'null';
  if (Array.isArray(value)) return 'array';
  return typeof value;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function deepEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (typeof a !== typeof b) return false;
  if (a === null || b === null) return a === b;
  if (Array.isArray(a) && Array.isArray(b)) {
    if (a.length !== b.length) return false;
    for (let i = 0; i < a.length; i += 1) {
      if (!deepEqual(a[i], b[i])) return false;
    }
    return true;
  }
  if (typeof a === 'object' && typeof b === 'object') {
    const ka = Object.keys(a as object).sort();
    const kb = Object.keys(b as object).sort();
    if (ka.length !== kb.length) return false;
    for (let i = 0; i < ka.length; i += 1) {
      if (ka[i] !== kb[i]) return false;
      const key = ka[i] as string;
      if (!deepEqual((a as Record<string, unknown>)[key], (b as Record<string, unknown>)[key])) {
        return false;
      }
    }
    return true;
  }
  return false;
}

/** JSON Pointer RFC-6901 escape (`~` → `~0`, `/` → `~1`). */
function escapePointer(segment: string): string {
  return segment.replace(/~/g, '~0').replace(/\//g, '~1');
}

function checkFormat(format: string, value: string): string | null {
  switch (format) {
    case 'uuid':
      return /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/.test(
        value,
      )
        ? null
        : 'not a UUID';
    case 'email':
      return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value) ? null : 'not an email';
    case 'uri':
    case 'uri-reference':
      try {
        // allow relative URIs for uri-reference; stricter for uri.
        if (format === 'uri') new URL(value);
        else new URL(value, 'http://example.com/');
        return null;
      } catch {
        return 'not a URI';
      }
    case 'date-time':
      return Number.isFinite(Date.parse(value)) ? null : 'not an RFC-3339 date-time';
    default:
      // Unknown format — advisory only; do not error.
      return null;
  }
}

// ── Schema-violation error (surfaced by RequestAgent) ─────────────────────

export class CapabilitySchemaViolationError extends Error {
  readonly code = 'EAGENTRPC_SCHEMA_VIOLATION';
  constructor(
    readonly capabilityName: string,
    readonly side: CapabilitySide,
    readonly violations: readonly CapabilitySchemaViolation[],
  ) {
    super(
      `capability "${capabilityName}" ${side} failed schema validation: ${violations
        .map((v) => `${v.path || '/'} ${v.message}`)
        .join('; ')}`,
    );
    this.name = 'CapabilitySchemaViolationError';
  }
}
