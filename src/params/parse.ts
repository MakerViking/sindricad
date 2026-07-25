// Expression tokenizer + parser for the parameters engine. No dependencies.
//
// Grammar (Fusion-flavored):
//   expr    := add
//   add     := mul (('+'|'-') mul)*
//   mul     := unary (('*'|'/') unary)*
//   unary   := '-' unary | pow
//   pow     := primary ('^' unary)?           // right-assoc; -2^2 = -(2^2)
//   primary := NUMBER unit? | IDENT '(' expr (';' expr)* ')' | IDENT | '(' expr ')'
//
// Unit suffixes bind to NUMBER literals only and convert to canonical units at
// parse time (lengths → mm, angles → degrees); the AST keeps the unit tag so a
// dimensional checker can be added later without a format change. Function
// arguments use SEMICOLON separators (Fusion convention — comma is ambiguous in
// comma-decimal locales). Identifiers are case-sensitive; '.' is rejected in
// identifiers (qualified names are reserved for the future).

export class ExprError extends Error {
  constructor(
    message: string,
    readonly pos?: number,
  ) {
    super(message);
  }
}

/** unit suffix → factor into the canonical unit of its dimension */
export const UNITS: Record<string, { factor: number; dim: "length" | "angle" }> = {
  mm: { factor: 1, dim: "length" },
  cm: { factor: 10, dim: "length" },
  in: { factor: 25.4, dim: "length" },
  deg: { factor: 1, dim: "angle" },
  rad: { factor: 180 / Math.PI, dim: "angle" },
};

/** Implemented tier-1 functions. Trig takes/returns DEGREES for angles (the
 *  canonical angle unit) — sin(30) = 0.5; use a `rad` literal to feed radians. */
export const FUNCTIONS: Record<string, { arity: [number, number]; apply: (args: number[]) => number }> = {
  sin: { arity: [1, 1], apply: ([a]) => Math.sin((a! * Math.PI) / 180) },
  cos: { arity: [1, 1], apply: ([a]) => Math.cos((a! * Math.PI) / 180) },
  tan: { arity: [1, 1], apply: ([a]) => Math.tan((a! * Math.PI) / 180) },
  asin: { arity: [1, 1], apply: ([a]) => (Math.asin(a!) * 180) / Math.PI },
  acos: { arity: [1, 1], apply: ([a]) => (Math.acos(a!) * 180) / Math.PI },
  atan: { arity: [1, 1], apply: ([a]) => (Math.atan(a!) * 180) / Math.PI },
  floor: { arity: [1, 1], apply: ([a]) => Math.floor(a!) },
  ceil: { arity: [1, 1], apply: ([a]) => Math.ceil(a!) },
  round: { arity: [1, 1], apply: ([a]) => Math.round(a!) },
  abs: { arity: [1, 1], apply: ([a]) => Math.abs(a!) },
  sqrt: { arity: [1, 1], apply: ([a]) => Math.sqrt(a!) },
  min: { arity: [2, Infinity], apply: (args) => Math.min(...args) },
  max: { arity: [2, Infinity], apply: (args) => Math.max(...args) },
};

/** Reserved-but-unimplemented function names (future grammar additions must not
 *  be shadowed by user parameters). */
export const RESERVED_FUNCTIONS = new Set([
  "if", "pow", "ln", "log", "exp", "sign", "random", "sinh", "cosh", "tanh",
]);

export const CONSTANTS: Record<string, number> = { PI: Math.PI };

/** Every name a user parameter may NOT take. */
export function isReservedName(name: string): boolean {
  return name in FUNCTIONS || RESERVED_FUNCTIONS.has(name) || name in UNITS || name in CONSTANTS;
}

// --- tokens ---

export type Token =
  | { kind: "num"; value: number; start: number; end: number }
  | { kind: "ident"; name: string; start: number; end: number }
  | { kind: "op"; op: string; start: number; end: number };

const IDENT_START = /[A-Za-z_]/;
const IDENT_PART = /[A-Za-z0-9_]/;

export function tokenize(src: string): Token[] {
  const out: Token[] = [];
  let i = 0;
  while (i < src.length) {
    const ch = src[i]!;
    if (ch === " " || ch === "\t") {
      i++;
      continue;
    }
    if (ch >= "0" && ch <= "9" || (ch === "." && src[i + 1]! >= "0" && src[i + 1]! <= "9")) {
      const start = i;
      while (i < src.length && ((src[i]! >= "0" && src[i]! <= "9") || src[i] === ".")) i++;
      if (src[i] === "e" || src[i] === "E") {
        let j = i + 1;
        if (src[j] === "+" || src[j] === "-") j++;
        if (src[j]! >= "0" && src[j]! <= "9") {
          i = j;
          while (i < src.length && src[i]! >= "0" && src[i]! <= "9") i++;
        }
      }
      const text = src.slice(start, i);
      const value = Number(text);
      if (!Number.isFinite(value)) throw new ExprError(`invalid number "${text}"`, start);
      out.push({ kind: "num", value, start, end: i });
      continue;
    }
    if (IDENT_START.test(ch)) {
      const start = i;
      while (i < src.length && IDENT_PART.test(src[i]!)) i++;
      if (src[i] === ".") throw new ExprError("qualified names ('.') are not supported", i);
      out.push({ kind: "ident", name: src.slice(start, i), start, end: i });
      continue;
    }
    if ("+-*/^();".includes(ch)) {
      out.push({ kind: "op", op: ch, start: i, end: i + 1 });
      i++;
      continue;
    }
    throw new ExprError(`unexpected character "${ch}"`, i);
  }
  return out;
}

// --- AST ---

export type ExprNode =
  | { t: "num"; v: number; unit?: keyof typeof UNITS } // v is ALREADY canonical
  | { t: "ref"; name: string }
  | { t: "call"; name: string; args: ExprNode[] }
  | { t: "bin"; op: "+" | "-" | "*" | "/" | "^"; l: ExprNode; r: ExprNode }
  | { t: "neg"; e: ExprNode };

class Parser {
  private i = 0;
  constructor(private readonly toks: Token[]) {}

  private peek(): Token | undefined {
    return this.toks[this.i];
  }
  private takeOp(op: string): boolean {
    const t = this.peek();
    if (t?.kind === "op" && t.op === op) {
      this.i++;
      return true;
    }
    return false;
  }

  parse(): ExprNode {
    if (this.toks.length === 0) throw new ExprError("empty expression");
    const node = this.add();
    const left = this.peek();
    if (left) throw new ExprError(`unexpected "${left.kind === "op" ? left.op : left.kind === "ident" ? left.name : left.value}"`, left.start);
    return node;
  }

  private add(): ExprNode {
    let l = this.mul();
    for (;;) {
      if (this.takeOp("+")) l = { t: "bin", op: "+", l, r: this.mul() };
      else if (this.takeOp("-")) l = { t: "bin", op: "-", l, r: this.mul() };
      else return l;
    }
  }
  private mul(): ExprNode {
    let l = this.unary();
    for (;;) {
      if (this.takeOp("*")) l = { t: "bin", op: "*", l, r: this.unary() };
      else if (this.takeOp("/")) l = { t: "bin", op: "/", l, r: this.unary() };
      else return l;
    }
  }
  private unary(): ExprNode {
    if (this.takeOp("-")) return { t: "neg", e: this.unary() };
    return this.pow();
  }
  private pow(): ExprNode {
    const base = this.primary();
    if (this.takeOp("^")) return { t: "bin", op: "^", l: base, r: this.unary() };
    return base;
  }
  private primary(): ExprNode {
    const t = this.peek();
    if (!t) throw new ExprError("unexpected end of expression");
    if (t.kind === "num") {
      this.i++;
      const suffix = this.peek();
      if (suffix?.kind === "ident" && suffix.name in UNITS) {
        this.i++;
        const u = UNITS[suffix.name]!;
        return { t: "num", v: t.value * u.factor, unit: suffix.name };
      }
      return { t: "num", v: t.value };
    }
    if (t.kind === "ident") {
      this.i++;
      if (this.takeOp("(")) {
        const args: ExprNode[] = [this.add()];
        while (this.takeOp(";")) args.push(this.add());
        if (!this.takeOp(")")) throw new ExprError(`missing ")" in ${t.name}(…)`, this.peek()?.start ?? t.end);
        return { t: "call", name: t.name, args };
      }
      return { t: "ref", name: t.name };
    }
    if (t.op === "(") {
      this.i++;
      const inner = this.add();
      if (!this.takeOp(")")) throw new ExprError('missing ")"', this.peek()?.start ?? t.end);
      return inner;
    }
    throw new ExprError(`unexpected "${t.op}"`, t.start);
  }
}

export function parseExpr(src: string): ExprNode {
  return new Parser(tokenize(src)).parse();
}

/** Parameter names a parsed expression references (constants excluded). */
export function refsOfNode(node: ExprNode): string[] {
  const refs = new Set<string>();
  const walk = (n: ExprNode): void => {
    switch (n.t) {
      case "ref":
        if (!(n.name in CONSTANTS)) refs.add(n.name);
        return;
      case "call":
        n.args.forEach(walk);
        return;
      case "bin":
        walk(n.l);
        walk(n.r);
        return;
      case "neg":
        walk(n.e);
        return;
      case "num":
        return;
    }
  };
  walk(node);
  return [...refs];
}

/** Parameter names an expression references (constants/functions/units excluded). */
export function extractRefs(src: string): string[] {
  return refsOfNode(parseExpr(src));
}

/** Is `s` a lexically valid parameter identifier? (Same rule as the tokenizer.) */
export function isIdentName(s: string): boolean {
  return s.length > 0 && IDENT_START.test(s[0]!) && [...s].every((c) => IDENT_PART.test(c));
}

/** Rewrite every reference to `from` as `to`, preserving the source verbatim
 *  otherwise (token-level splice — never a regex, so "width" can't hit "widths",
 *  a unit suffix, or a function name). Assumes `src` parses. */
export function renameRefs(src: string, from: string, to: string): string {
  const toks = tokenize(src);
  let out = "";
  let last = 0;
  for (let i = 0; i < toks.length; i++) {
    const t = toks[i]!;
    if (t.kind !== "ident" || t.name !== from) continue;
    // an ident directly followed by "(" is a function name, not a reference —
    // unreachable for valid renames (param names can't shadow functions), but
    // keep the splice honest anyway
    const next = toks[i + 1];
    if (next?.kind === "op" && next.op === "(") continue;
    // a unit suffix directly after a number is not a reference
    const prev = toks[i - 1];
    if (prev?.kind === "num" && t.name in UNITS) continue;
    out += src.slice(last, t.start) + to;
    last = t.end;
  }
  return out + src.slice(last);
}

/** True when the expression is just a literal number (with optional unit) —
 *  i.e. NOT worth an fx: badge. */
export function isNumericLiteral(src: string): boolean {
  try {
    const n = parseExpr(src);
    return n.t === "num" || (n.t === "neg" && n.e.t === "num");
  } catch {
    return false;
  }
}
