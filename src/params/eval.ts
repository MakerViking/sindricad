// Expression evaluation against a name→value scope. Values and results are in
// canonical units (mm / degrees / raw counts). Evaluation never throws on
// arithmetic (÷0 → Infinity); callers gate on Number.isFinite (a non-finite
// result keeps the previous cached value — never ships into geometry). It DOES
// throw ExprError on structural problems: unknown parameter, unknown function,
// wrong arity — those are reject-at-commit errors.

import { CONSTANTS, ExprError, FUNCTIONS, RESERVED_FUNCTIONS, parseExpr } from "./parse";
import type { ExprNode } from "./parse";

export function evalNode(n: ExprNode, values: Record<string, number>): number {
  switch (n.t) {
    case "num":
      return n.v;
    case "ref": {
      if (n.name in values) return values[n.name]!;
      if (n.name in CONSTANTS) return CONSTANTS[n.name]!;
      throw new ExprError(`unknown parameter "${n.name}"`);
    }
    case "call": {
      const fn = FUNCTIONS[n.name];
      if (!fn) {
        throw new ExprError(
          RESERVED_FUNCTIONS.has(n.name) ? `${n.name}() is not supported yet` : `unknown function "${n.name}"`,
        );
      }
      const [lo, hi] = fn.arity;
      if (n.args.length < lo || n.args.length > hi) {
        throw new ExprError(`${n.name}() takes ${hi === Infinity ? `at least ${lo}` : lo === hi ? lo : `${lo}–${hi}`} argument${lo === 1 && hi === 1 ? "" : "s"}`);
      }
      return fn.apply(n.args.map((a) => evalNode(a, values)));
    }
    case "bin": {
      const l = evalNode(n.l, values);
      const r = evalNode(n.r, values);
      switch (n.op) {
        case "+": return l + r;
        case "-": return l - r;
        case "*": return l * r;
        case "/": return l / r;
        case "^": return Math.pow(l, r);
      }
    }
    // eslint-disable-next-line no-fallthrough -- the inner switch returns on every op
    case "neg":
      return -evalNode(n.e, values);
  }
}

/** Parse + evaluate `src` against `values`. Throws ExprError on structural
 *  errors; may return a non-finite number (caller decides what that means). */
export function evalExpr(src: string, values: Record<string, number>): number {
  return evalNode(parseExpr(src), values);
}
