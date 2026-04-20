import { resolveJsonPath } from './jsonpath.js';

/**
 * Tiny filter expression language. Hand-rolled recursive-descent parser
 * — no peer deps. Operators, in precedence order (low → high):
 *
 *   or
 *   and
 *   not
 *   == != < <= > >= in
 *   (parens)
 *
 * Values: numbers, strings (`"..."` or `'...'`), `true`, `false`, `null`,
 * array literals (`[1, "two", false]`), and JSONPath references (`$.x.y`).
 *
 * Example predicates:
 *   `$.amount > 100`
 *   `$.status == "active"`
 *   `$.kind in ["order.placed", "order.cancelled"]`
 *   `$.urgent and not $.snoozed`
 *   `($.x > 0) or ($.y > 0)`
 *
 * JSONPath references that don't resolve return `undefined`; comparisons
 * against `undefined` yield `false` unless you explicitly test with
 * `== null`.
 */

export class FilterExpressionError extends Error {
  readonly code = 'EFILTEREXPR';
  constructor(
    public readonly expr: string,
    public readonly reason: string,
  ) {
    super(`filter expression "${expr}": ${reason}`);
    this.name = 'FilterExpressionError';
  }
}

// ─── Tokens ──────────────────────────────────────────────────────────────

type TokenKind =
  | 'number'
  | 'string'
  | 'ident' // `true`, `false`, `null`, `and`, `or`, `not`, `in`
  | 'jsonpath'
  | 'op' // `==`, `!=`, `<`, `<=`, `>`, `>=`
  | 'lparen'
  | 'rparen'
  | 'lbracket'
  | 'rbracket'
  | 'comma';

interface Token {
  kind: TokenKind;
  value: string;
  pos: number;
}

function tokenize(input: string): Token[] {
  const out: Token[] = [];
  let i = 0;
  while (i < input.length) {
    const c = input[i] as string;
    if (/\s/.test(c)) {
      i += 1;
      continue;
    }
    // JSONPath ref starts with $; consume until end of expression token.
    // Track bracket depth so `$.arr[0]` reads as one path while `$.x in [1]`
    // still stops before the `[` that opens the `in` array literal.
    if (c === '$') {
      let j = i + 1;
      let depth = 0;
      while (j < input.length) {
        const ch = input[j] as string;
        if (depth === 0) {
          if (/\s/.test(ch)) break;
          if (ch === ',' || ch === '(' || ch === ')') break;
          if (ch === ']') break;
          if (ch === '=' || ch === '!' || ch === '<' || ch === '>') break;
        }
        if (ch === '[') depth += 1;
        else if (ch === ']') depth -= 1;
        j += 1;
      }
      out.push({ kind: 'jsonpath', value: input.slice(i, j), pos: i });
      i = j;
      continue;
    }
    if (c === '(' || c === ')') {
      out.push({ kind: c === '(' ? 'lparen' : 'rparen', value: c, pos: i });
      i += 1;
      continue;
    }
    if (c === '[' || c === ']') {
      out.push({ kind: c === '[' ? 'lbracket' : 'rbracket', value: c, pos: i });
      i += 1;
      continue;
    }
    if (c === ',') {
      out.push({ kind: 'comma', value: c, pos: i });
      i += 1;
      continue;
    }
    if (c === '"' || c === "'") {
      const quote = c;
      let j = i + 1;
      let str = '';
      while (j < input.length && input[j] !== quote) {
        if (input[j] === '\\' && j + 1 < input.length) {
          str += input[j + 1];
          j += 2;
        } else {
          str += input[j];
          j += 1;
        }
      }
      if (input[j] !== quote) {
        throw new FilterExpressionError(input, `unterminated string starting at ${i}`);
      }
      out.push({ kind: 'string', value: str, pos: i });
      i = j + 1;
      continue;
    }
    if (/[0-9]/.test(c) || (c === '-' && /[0-9]/.test(input[i + 1] ?? ''))) {
      let j = i;
      if (input[j] === '-') j += 1;
      while (j < input.length && /[0-9.]/.test(input[j] ?? '')) j += 1;
      out.push({ kind: 'number', value: input.slice(i, j), pos: i });
      i = j;
      continue;
    }
    if (c === '=' || c === '!' || c === '<' || c === '>') {
      const two = input.slice(i, i + 2);
      if (two === '==' || two === '!=' || two === '<=' || two === '>=') {
        out.push({ kind: 'op', value: two, pos: i });
        i += 2;
        continue;
      }
      if (c === '<' || c === '>') {
        out.push({ kind: 'op', value: c, pos: i });
        i += 1;
        continue;
      }
      throw new FilterExpressionError(input, `unexpected "${c}" at position ${i}`);
    }
    if (/[a-zA-Z_]/.test(c)) {
      let j = i;
      while (j < input.length && /[a-zA-Z0-9_]/.test(input[j] ?? '')) j += 1;
      out.push({ kind: 'ident', value: input.slice(i, j), pos: i });
      i = j;
      continue;
    }
    throw new FilterExpressionError(input, `unexpected character "${c}" at position ${i}`);
  }
  return out;
}

// ─── AST ─────────────────────────────────────────────────────────────────

type BinaryOp = '==' | '!=' | '<' | '<=' | '>' | '>=' | 'and' | 'or';

export type Expr =
  | { kind: 'literal'; value: unknown }
  | { kind: 'jsonpath'; path: string }
  | { kind: 'binary'; op: BinaryOp; left: Expr; right: Expr }
  | { kind: 'unary'; op: 'not'; operand: Expr }
  | { kind: 'in'; value: Expr; arr: Expr[] };

// ─── Parser ──────────────────────────────────────────────────────────────

class Parser {
  private pos = 0;
  constructor(
    private readonly tokens: readonly Token[],
    private readonly src: string,
  ) {}

  parse(): Expr {
    const expr = this.parseOr();
    if (this.pos < this.tokens.length) {
      throw new FilterExpressionError(
        this.src,
        `unexpected trailing token "${this.tokens[this.pos]?.value}"`,
      );
    }
    return expr;
  }

  private peek(): Token | undefined {
    return this.tokens[this.pos];
  }

  private consume(): Token {
    const t = this.tokens[this.pos];
    if (!t) throw new FilterExpressionError(this.src, 'unexpected end of expression');
    this.pos += 1;
    return t;
  }

  private matchIdent(value: string): boolean {
    const t = this.peek();
    if (t?.kind === 'ident' && t.value === value) {
      this.pos += 1;
      return true;
    }
    return false;
  }

  private parseOr(): Expr {
    let left = this.parseAnd();
    while (this.matchIdent('or')) {
      const right = this.parseAnd();
      left = { kind: 'binary', op: 'or', left, right };
    }
    return left;
  }

  private parseAnd(): Expr {
    let left = this.parseNot();
    while (this.matchIdent('and')) {
      const right = this.parseNot();
      left = { kind: 'binary', op: 'and', left, right };
    }
    return left;
  }

  private parseNot(): Expr {
    if (this.matchIdent('not')) {
      return { kind: 'unary', op: 'not', operand: this.parseNot() };
    }
    return this.parseCmp();
  }

  private parseCmp(): Expr {
    const left = this.parsePrimary();
    const t = this.peek();
    if (t?.kind === 'op') {
      this.consume();
      const right = this.parsePrimary();
      return { kind: 'binary', op: t.value as BinaryOp, left, right };
    }
    if (t?.kind === 'ident' && t.value === 'in') {
      this.consume();
      const arr = this.parseArray();
      return { kind: 'in', value: left, arr };
    }
    return left;
  }

  private parsePrimary(): Expr {
    const t = this.peek();
    if (!t) throw new FilterExpressionError(this.src, 'unexpected end of expression');
    if (t.kind === 'lparen') {
      this.consume();
      const inner = this.parseOr();
      if (this.peek()?.kind !== 'rparen') {
        throw new FilterExpressionError(this.src, `expected ")" at position ${this.peek()?.pos}`);
      }
      this.consume();
      return inner;
    }
    if (t.kind === 'number') {
      this.consume();
      return { kind: 'literal', value: Number.parseFloat(t.value) };
    }
    if (t.kind === 'string') {
      this.consume();
      return { kind: 'literal', value: t.value };
    }
    if (t.kind === 'ident') {
      if (t.value === 'true' || t.value === 'false') {
        this.consume();
        return { kind: 'literal', value: t.value === 'true' };
      }
      if (t.value === 'null') {
        this.consume();
        return { kind: 'literal', value: null };
      }
    }
    if (t.kind === 'jsonpath') {
      this.consume();
      return { kind: 'jsonpath', path: t.value };
    }
    throw new FilterExpressionError(this.src, `unexpected token "${t.value}" at position ${t.pos}`);
  }

  private parseArray(): Expr[] {
    const t = this.peek();
    if (t?.kind !== 'lbracket') {
      throw new FilterExpressionError(this.src, `expected "[" after "in" at position ${t?.pos}`);
    }
    this.consume();
    const items: Expr[] = [];
    if (this.peek()?.kind !== 'rbracket') {
      items.push(this.parsePrimary());
      while (this.peek()?.kind === 'comma') {
        this.consume();
        items.push(this.parsePrimary());
      }
    }
    if (this.peek()?.kind !== 'rbracket') {
      throw new FilterExpressionError(this.src, `expected "]" at position ${this.peek()?.pos}`);
    }
    this.consume();
    return items;
  }
}

export function parseFilterExpression(expr: string): Expr {
  const tokens = tokenize(expr);
  if (tokens.length === 0) {
    throw new FilterExpressionError(expr, 'empty expression');
  }
  return new Parser(tokens, expr).parse();
}

// ─── Evaluator ───────────────────────────────────────────────────────────

/**
 * Evaluate `ast` against `context` — typically the decoded message
 * body. Returns `true` / `false`. Unresolved JSONPaths yield
 * `undefined`; comparisons against undefined are false.
 */
export function evaluate(ast: Expr, context: unknown): unknown {
  switch (ast.kind) {
    case 'literal':
      return ast.value;
    case 'jsonpath':
      return resolveJsonPath(context, ast.path);
    case 'unary':
      return !evaluate(ast.operand, context);
    case 'binary': {
      if (ast.op === 'and') return !!evaluate(ast.left, context) && !!evaluate(ast.right, context);
      if (ast.op === 'or') return !!evaluate(ast.left, context) || !!evaluate(ast.right, context);
      const left = evaluate(ast.left, context);
      const right = evaluate(ast.right, context);
      switch (ast.op) {
        case '==':
          return looseEquals(left, right);
        case '!=':
          return !looseEquals(left, right);
        case '<':
          return cmp(left, right) < 0;
        case '<=':
          return cmp(left, right) <= 0;
        case '>':
          return cmp(left, right) > 0;
        case '>=':
          return cmp(left, right) >= 0;
      }
      return undefined;
    }
    case 'in': {
      const v = evaluate(ast.value, context);
      for (const item of ast.arr) {
        if (looseEquals(v, evaluate(item, context))) return true;
      }
      return false;
    }
  }
}

function looseEquals(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (a === null || a === undefined || b === null || b === undefined) return false;
  if (typeof a === 'number' && typeof b === 'number') return a === b;
  if (typeof a === 'string' && typeof b === 'string') return a === b;
  // Light coercion: number vs numeric-string.
  if (typeof a === 'number' && typeof b === 'string') return a === Number.parseFloat(b);
  if (typeof b === 'number' && typeof a === 'string') return b === Number.parseFloat(a);
  return false;
}

function cmp(a: unknown, b: unknown): number {
  if (a === undefined || a === null || b === undefined || b === null) return Number.NaN;
  if (typeof a === 'number' && typeof b === 'number') return a - b;
  if (typeof a === 'string' && typeof b === 'string') return a < b ? -1 : a > b ? 1 : 0;
  return Number.NaN;
}

/** Convenience: parse + evaluate in one call. Returns the final boolean. */
export function evaluateFilter(expr: string, context: unknown): boolean {
  return !!evaluate(parseFilterExpression(expr), context);
}
