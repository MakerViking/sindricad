// The imported-assembly grouping the Browser panel renders.
//
// DOM emission is not covered here (no jsdom in this project, deliberately —
// see vitest.config.ts). What IS covered is the part with real logic: walking a
// body's node chain to the root, keeping sibling identity straight, and refusing
// to lose a body when the manifest is malformed.
import { describe, expect, it } from "vitest";
import { buildAssemblyGroups } from "./browserTree";

type Node = { name: string; parent: number | null };

/** The shape sidecar/step_assembly.py emits for asm_nested.step: a root with a
 *  subassembly instanced twice, each holding two products. */
const NESTED: Node[] = [
  { name: "Robot", parent: null },       // 0
  { name: "Electronics", parent: 0 },    // 1
  { name: "Board", parent: 1 },          // 2
  { name: "MCU", parent: 2 },            // 3
  { name: "Header (x2)", parent: 2 },    // 4
  { name: "Board", parent: 1 },          // 5  <- same NAME, different occurrence
  { name: "MCU", parent: 5 },            // 6
  { name: "Header (x2)", parent: 5 },    // 7
  { name: "Chassis", parent: 0 },        // 8
];

const trees = (nodes: Node[]) => new Map([["f1", nodes]]);
const body = (id: string, name: string, nodeRef?: string) =>
  nodeRef === undefined ? { id, name } : { id, name, nodeRef };

describe("buildAssemblyGroups", () => {
  it("returns null when no body belongs to an assembly", () => {
    const out = buildAssemblyGroups([body("body1", "Body1"), body("body2", "Body2")], trees(NESTED));
    expect(out).toBeNull();
  });

  it("nests bodies under their product's full ancestor chain", () => {
    const out = buildAssemblyGroups([body("body1", "MCU", "f1/3")], trees(NESTED))!;
    expect(out.roots).toHaveLength(1);
    const robot = out.roots[0]!;
    expect(robot.label).toBe("Robot");
    expect(robot.children[0]!.label).toBe("Electronics");
    expect(robot.children[0]!.children[0]!.label).toBe("Board");
    expect(out.ancestors.get("body1")).toEqual(["n:f1/0", "n:f1/1", "n:f1/2", "n:f1/3"]);
  });

  it("keeps two occurrences of the same subassembly separate", () => {
    // Both are called "Board". Keyed on the NODE INDEX, not the display name,
    // they must stay two independent groups — otherwise selecting or collapsing
    // one silently affects the other.
    const out = buildAssemblyGroups(
      [body("body1", "MCU", "f1/3"), body("body2", "MCU", "f1/6")],
      trees(NESTED),
    )!;
    const electronics = out.roots[0]!.children[0]!;
    expect(electronics.children).toHaveLength(2);
    expect(electronics.children.map((c) => c.label)).toEqual(["Board", "Board"]);
    expect(electronics.children[0]!.key).not.toBe(electronics.children[1]!.key);
  });

  it("groups every solid of a multi-solid product under one node", () => {
    const out = buildAssemblyGroups(
      [
        body("body1", "Header (x2) 1", "f1/4"),
        body("body2", "Header (x2) 2", "f1/4"),
      ],
      trees(NESTED),
    )!;
    const board = out.roots[0]!.children[0]!.children[0]!;
    expect(board.children).toHaveLength(1);
    expect(board.children[0]!.bodies.map((b) => b.name)).toEqual([
      "Header (x2) 1",
      "Header (x2) 2",
    ]);
  });

  it("counts every descendant body, not just direct children", () => {
    const out = buildAssemblyGroups(
      [
        body("body1", "MCU", "f1/3"),
        body("body2", "Header (x2) 1", "f1/4"),
        body("body3", "Header (x2) 2", "f1/4"),
        body("body4", "MCU", "f1/6"),
        body("body5", "Chassis", "f1/8"),
      ],
      trees(NESTED),
    )!;
    expect(out.roots[0]!.total).toBe(5); // Robot
    expect(out.roots[0]!.children[0]!.total).toBe(4); // Electronics
  });

  it("keeps a body whose nodeRef does not resolve, rather than dropping it", () => {
    // A body missing from the browser is invisible AND unselectable — strictly
    // worse than one shown at the top level.
    const out = buildAssemblyGroups(
      [
        body("body1", "MCU", "f1/3"),
        body("body2", "Orphan", "f1/999"), // index past the end
        body("body3", "Wrong feature", "f9/0"), // unknown import
        body("body4", "Malformed", "nonsense"), // no slash
      ],
      trees(NESTED),
    )!;
    expect(out.loose.map((b) => b.name)).toEqual(["Orphan", "Wrong feature", "Malformed"]);
  });

  it("survives a cyclic parent chain in a hand-edited document", () => {
    const cyclic: Node[] = [
      { name: "A", parent: 1 },
      { name: "B", parent: 0 },
    ];
    const out = buildAssemblyGroups([body("body1", "x", "f1/0")], trees(cyclic))!;
    // terminates, and still files the body somewhere reachable
    expect(out.loose).toHaveLength(0);
    expect(out.roots).toHaveLength(1);
  });

  it("falls back to a placeholder for an unnamed product", () => {
    const out = buildAssemblyGroups(
      [body("body1", "x", "f1/0")],
      trees([{ name: "", parent: null }]),
    )!;
    expect(out.roots[0]!.label).toBe("Part");
  });

  it("collapses a large assembly to a handful of top-level rows", () => {
    // The row-count claim behind shipping this without virtualisation: assembly
    // nodes default to collapsed, so a 3,000-body import paints its ROOTS, not
    // 3,000 rows. Modelled on the reference file: one root, 12 levels deep.
    const nodes: Node[] = [{ name: "Root", parent: null }];
    const bodies = [];
    for (let i = 0; i < 3000; i++) {
      nodes.push({ name: `Sub ${i}`, parent: 0 });
      nodes.push({ name: `Part ${i}`, parent: nodes.length - 1 });
      bodies.push(body(`body${i}`, `Part ${i}`, `f1/${nodes.length - 1}`));
    }
    const out = buildAssemblyGroups(bodies, trees(nodes))!;
    // collapsed, the panel emits one head per ROOT — not one row per body
    expect(out.roots).toHaveLength(1);
    expect(out.roots[0]!.total).toBe(3000);
    expect(out.loose).toHaveLength(0);
  });

  it("mixes assembly bodies with ordinary ones in the same document", () => {
    const out = buildAssemblyGroups(
      [body("body1", "Extrude1"), body("body2", "MCU", "f1/3")],
      trees(NESTED),
    )!;
    expect(out.loose.map((b) => b.name)).toEqual(["Extrude1"]);
    expect(out.roots).toHaveLength(1);
  });
});
