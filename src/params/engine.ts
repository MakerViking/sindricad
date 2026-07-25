// The parameters engine: evaluates the document's parameter table (paramDefs),
// writes evaluated numbers into bound fields, and owns the lifecycle rules
// (bind/rename/delete/cycle). All functions mutate the given document IN PLACE
// and are meant to run inside one store.mutate() so a parameter edit and its
// write-back cascade land as a single undo step. The sidecar never sees any of
// this — only the derived `doc.parameters` numbers and the fields themselves.
//
// Invariants:
//  - `paramDefs` is the source of truth; `doc.parameters` is a derived
//    name→value cache regenerated after every recompute.
//  - The engine is the sole writer of bound fields (a field's number always
//    equals its bound param's cached value after recompute).
//  - A broken expression is never STORED via the commit path (validate first);
//    load-time breakage (hand-edited files) keeps the cached value and is
//    reported in `issues`.

import type { CadDocument, ParamDef, ParamTarget } from "../types";
import { ExprError, isIdentName, isNumericLiteral, isReservedName, parseExpr, refsOfNode, renameRefs } from "./parse";
import type { ExprNode } from "./parse";
import { evalNode } from "./eval";
import { kindUnit, NON_NUM_STRING_FIELDS, resolveTarget, writeTarget } from "../document/numFields";
import type { FieldKind } from "../document/numFields";

export interface RecomputeResult {
  /** sketch feature ids whose constraint/entity/pattern values changed — these
   *  need a re-solve (open sketch: live; closed: headless cascade). */
  affectedSketches: Set<string>;
  /** param name → why it kept its cached value (cycle, unknown ref, non-finite,
   *  missing target). Empty on a healthy document. */
  issues: Record<string, string>;
}

export function defsOf(doc: CadDocument): Record<string, ParamDef> {
  return (doc.paramDefs ??= {});
}

/** Next free auto model-parameter name (d1, d2, …). */
export function nextDName(defs: Record<string, ParamDef>): string {
  let n = 1;
  for (const name of Object.keys(defs)) {
    const m = /^d(\d+)$/.exec(name);
    if (m) n = Math.max(n, Number(m[1]) + 1);
  }
  return `d${n}`;
}

/** Parse every def once; an unparsable expression maps to null (it will surface
 *  as an issue at evaluation and can't reference anything). */
function parseDefs(defs: Record<string, ParamDef>): Map<string, ExprNode | null> {
  const nodes = new Map<string, ExprNode | null>();
  for (const [name, def] of Object.entries(defs)) {
    try {
      nodes.set(name, parseExpr(def.expr));
    } catch {
      nodes.set(name, null);
    }
  }
  return nodes;
}

function refsOf(def: ParamDef, defs: Record<string, ParamDef>): string[] {
  try {
    return extractDefRefs(parseExpr(def.expr), defs);
  } catch {
    return []; // unparsable expr surfaces as an issue during evaluation
  }
}

function extractDefRefs(node: ExprNode | null, defs: Record<string, ParamDef>): string[] {
  return node ? refsOfNode(node).filter((r) => r in defs) : [];
}

/** Re-evaluate the whole table in dependency order, write changed values into
 *  bound fields, refresh the derived `doc.parameters` cache, and drop model
 *  params whose target is gone and that nothing references. */
export function recompute(doc: CadDocument): RecomputeResult {
  const defs = defsOf(doc);
  const issues: Record<string, string> = {};
  const affectedSketches = new Set<string>();
  const nodes = parseDefs(defs);

  // --- GC dangling model params (their dim/feature was deleted). Unreferenced
  // ones are dropped SILENTLY by design — an auto-minted dN is meaningless
  // without its target, and undo restores it via the doc snapshot anyway. ---
  const referenced = new Set<string>();
  for (const name of nodes.keys()) for (const r of extractDefRefs(nodes.get(name)!, defs)) referenced.add(r);
  for (const [name, def] of Object.entries(defs)) {
    if (def.target && !resolveTarget(doc, def.target)) {
      if (referenced.has(name)) issues[name] = "its dimension or feature no longer exists";
      else {
        delete defs[name];
        nodes.delete(name);
      }
    }
  }

  // --- topological order (Kahn); cycle members keep their cached value ---
  const names = Object.keys(defs);
  const deps = new Map(names.map((n) => [n, extractDefRefs(nodes.get(n)!, defs)]));
  const indeg = new Map(names.map((n) => [n, deps.get(n)!.length]));
  const dependents = new Map<string, string[]>(names.map((n) => [n, []]));
  for (const n of names) for (const d of deps.get(n)!) dependents.get(d)!.push(n);
  const order: string[] = [];
  const queue = names.filter((n) => indeg.get(n) === 0);
  while (queue.length) {
    const n = queue.shift()!;
    order.push(n);
    for (const m of dependents.get(n)!) {
      const k = indeg.get(m)! - 1;
      indeg.set(m, k);
      if (k === 0) queue.push(m);
    }
  }
  const inOrder = new Set(order);
  for (const n of names) if (!inOrder.has(n)) issues[n] ??= "circular reference";

  // --- evaluate in order; every def contributes its (possibly cached) value ---
  const values: Record<string, number> = {};
  for (const n of names) values[n] = defs[n]!.value; // cycle/error fallback scope
  for (const n of order) {
    const def = defs[n]!;
    const node = nodes.get(n);
    if (!node) {
      issues[n] = "invalid expression";
      continue;
    }
    try {
      const v = evalNode(node, values);
      if (!Number.isFinite(v)) {
        issues[n] = "does not evaluate to a finite number";
      } else {
        def.value = v;
        values[n] = v;
      }
    } catch (e) {
      issues[n] = e instanceof ExprError ? e.message : String(e);
    }
  }

  // --- write changed values into bound fields ---
  for (const def of Object.values(defs)) {
    if (!def.target) continue;
    const w = writeTarget(doc, def.target, def.value);
    if (w?.sketch) affectedSketches.add(w.sketch);
  }

  // --- refresh the derived cache the sidecar/legacy readers consume ---
  doc.parameters = Object.fromEntries(Object.entries(defs).map(([n, d]) => [n, d.value]));

  return { affectedSketches, issues };
}

/** Would `expr` under `name` reference `name` back through the table? Returns
 *  the cycle chain for the error message, or null. */
function findCycle(defs: Record<string, ParamDef>, name: string, refs: string[]): string[] | null {
  const seen = new Set<string>();
  const walk = (from: string, path: string[]): string[] | null => {
    if (from === name) return [...path, from];
    if (seen.has(from)) return null;
    seen.add(from);
    const def = defs[from];
    if (!def) return null;
    for (const r of refsOf(def, defs)) {
      const hit = walk(r, [...path, from]);
      if (hit) return hit;
    }
    return null;
  };
  for (const r of refs) {
    const hit = walk(r, [name]);
    if (hit) return hit;
  }
  return null;
}

export type Validation = { ok: true; value: number } | { ok: false; error: string };

/** Strict commit-time validation: parse, known refs, no cycle, finite value,
 *  and no unit suffix when the destination is a count field. Never mutates. */
export function validateExpr(doc: CadDocument, name: string | null, expr: string, kind?: FieldKind): Validation {
  const defs = defsOf(doc);
  let node: ExprNode;
  try {
    node = parseExpr(expr);
  } catch (e) {
    return { ok: false, error: e instanceof ExprError ? e.message : String(e) };
  }
  const refs = refsOfNode(node);
  for (const r of refs) {
    if (!(r in defs)) return { ok: false, error: `unknown parameter "${r}"` };
    if (r === name) return { ok: false, error: `"${name}" cannot reference itself` };
  }
  if (name) {
    const cycle = findCycle(defs, name, refs);
    if (cycle) return { ok: false, error: `circular reference: ${cycle.join(" → ")}` };
  }
  if (kind === "count" && hasUnitLiteral(node)) {
    return { ok: false, error: "this field is unitless — write a plain number" };
  }
  const values = Object.fromEntries(Object.entries(defs).map(([n, d]) => [n, d.value]));
  let value: number;
  try {
    value = evalNode(node, values);
  } catch (e) {
    return { ok: false, error: e instanceof ExprError ? e.message : String(e) };
  }
  if (!Number.isFinite(value)) return { ok: false, error: "does not evaluate to a finite number" };
  return { ok: true, value };
}

function hasUnitLiteral(n: ExprNode): boolean {
  switch (n.t) {
    case "num": return n.unit !== undefined;
    case "ref": return false;
    case "call": return n.args.some(hasUnitLiteral);
    case "bin": return hasUnitLiteral(n.l) || hasUnitLiteral(n.r);
    case "neg": return hasUnitLiteral(n.e);
  }
}

/** Set an existing (or add a new user) parameter's expression. Validate with
 *  validateExpr FIRST — this trusts its input. Evaluation/write-back happens in
 *  store.mutate()'s recompute (the single owner of that invariant). */
export function commitParamExpr(doc: CadDocument, name: string, expr: string, unit?: ParamDef["unit"]): void {
  const defs = defsOf(doc);
  const def = defs[name];
  if (def) def.expr = expr;
  else defs[name] = { expr, value: 0, unit: unit ?? "mm" }; // new user parameter; value set by recompute
}

/** Reject bad user-parameter names in one place. Returns an error or null. */
export function validateName(defs: Record<string, ParamDef>, name: string): string | null {
  if (!isIdentName(name)) return "names are letters, digits and _ (not starting with a digit)";
  if (isReservedName(name)) return `"${name}" is a reserved name`;
  if (name in defs) return `"${name}" already exists`;
  if (/^d\d+$/.test(name)) return "dN names are reserved for model parameters";
  return null;
}

/** The param bound to `target`, if any. */
export function boundParam(doc: CadDocument, target: ParamTarget): string | null {
  for (const [name, def] of Object.entries(defsOf(doc))) {
    if (def.target && sameTarget(def.target, target)) return name;
  }
  return null;
}

function sameTarget(a: ParamTarget, b: ParamTarget): boolean {
  if (a.kind !== b.kind) return false;
  switch (a.kind) {
    case "feature": return b.kind === "feature" && a.feature === b.feature && a.field === b.field;
    case "constraint": return b.kind === "constraint" && a.sketch === b.sketch && a.constraint === b.constraint;
    case "entity": return b.kind === "entity" && a.sketch === b.sketch && a.entity === b.entity && a.field === b.field;
    case "pattern": return b.kind === "pattern" && a.sketch === b.sketch && a.pattern === b.pattern && a.field === b.field;
  }
}

/** True when `target` is driven by a non-literal expression — drag tools must
 *  not overwrite it (the fx: rule). The single definition of the fx predicate. */
export function isBound(doc: CadDocument, target: ParamTarget): boolean {
  const name = boundParam(doc, target);
  return name !== null && !isNumericLiteral(defsOf(doc)[name]!.expr);
}

/** Bind an expression to a field: updates the existing model param for that
 *  target or mints the next dN. Validate with validateExpr first (pass the
 *  bound name from boundParam, or null for a fresh binding). Evaluation and
 *  write-back happen in store.mutate()'s recompute. */
export function commitFieldExpr(doc: CadDocument, target: ParamTarget, expr: string, kind: FieldKind): void {
  const defs = defsOf(doc);
  const existing = boundParam(doc, target);
  if (existing) {
    defs[existing]!.expr = expr;
  } else {
    defs[nextDName(defs)] = { expr, value: 0, unit: kindUnit(kind), target };
  }
}

/** Fusion's on-the-fly `name=expr` in a dim field: the field's model param
 *  gets the CHOSEN name (renaming an existing dN binding). Validate the name
 *  (validateName) and the expr (validateExpr) first — this trusts its input. */
export function commitNamedFieldExpr(doc: CadDocument, target: ParamTarget, name: string, expr: string, kind: FieldKind): void {
  const defs = defsOf(doc);
  const existing = boundParam(doc, target);
  if (existing) commitRenameParam(doc, existing, name);
  else defs[name] = { expr: "0", value: 0, unit: kindUnit(kind), target };
  defs[name]!.expr = expr;
}

/** `width=30` typed into a field → { name, expr }; null for normal input. */
export function splitNameValue(raw: string): { name: string; expr: string } | null {
  const m = /^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(\S.*)$/.exec(raw);
  return m ? { name: m[1]!, expr: m[2]!.trim() } : null;
}

export interface ParamReference {
  /** referencing param name, or a human label for a legacy bare-name field */
  site: string;
}

/** Walk every legacy bare-name string field (feature + sketch entity) whose
 *  value is exactly `name`, calling `hit` with a label and a setter. */
function eachBareNameRef(doc: CadDocument, name: string, hit: (label: string, set: (v: string) => void) => void): void {
  for (const f of doc.features) {
    for (const [k, v] of Object.entries(f)) {
      if (v === name && !NON_NUM_STRING_FIELDS.has(k)) {
        hit(`${f.type} ${f.id} · ${k}`, (nv) => ((f as unknown as Record<string, unknown>)[k] = nv));
      }
    }
    if (f.type !== "sketch") continue;
    for (const e of f.entities) {
      for (const [k, v] of Object.entries(e)) {
        if (v === name && !NON_NUM_STRING_FIELDS.has(k)) {
          hit(`${e.type} in ${f.id} · ${k}`, (nv) => ((e as unknown as Record<string, unknown>)[k] = nv));
        }
      }
    }
  }
}

/** Everything that references `name`: other params' expressions, plus legacy
 *  bare-name strings still sitting in feature/entity fields. */
export function referencesTo(doc: CadDocument, name: string): string[] {
  const defs = defsOf(doc);
  const out: string[] = [];
  for (const [n, def] of Object.entries(defs)) {
    if (n !== name && refsOf(def, defs).includes(name)) out.push(n);
  }
  eachBareNameRef(doc, name, (label) => out.push(label));
  return out;
}

/** Why `name` can't be deleted right now, or null when it's free. */
export function deleteBlockers(doc: CadDocument, name: string): string | null {
  if (!(name in defsOf(doc))) return `no parameter "${name}"`;
  const refs = referencesTo(doc, name);
  if (refs.length) return `"${name}" is referenced by: ${refs.join(", ")}`;
  return null;
}

/** Remove a parameter. Check deleteBlockers FIRST — this trusts its input. */
export function commitDeleteParam(doc: CadDocument, name: string): void {
  delete defsOf(doc)[name];
}

/** Rename a parameter, rewriting every referencing expression via the
 *  tokenizer (never regex) and following legacy bare-name fields. Validate
 *  FIRST (`from` exists + validateName(to)) — this trusts its input. */
export function commitRenameParam(doc: CadDocument, from: string, to: string): void {
  const defs = defsOf(doc);
  for (const def of Object.values(defs)) {
    try {
      def.expr = renameRefs(def.expr, from, to);
    } catch {
      // an unparsable expr can't reference anything; leave it as-is
    }
  }
  defs[to] = defs[from]!;
  delete defs[from];
  eachBareNameRef(doc, from, (_label, set) => set(to));
}
