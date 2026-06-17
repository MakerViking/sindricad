// The §2 example: a parametric bracket with two holes and a filleted edge.
import type { CadDocument } from "../types";

export const EXAMPLE_BRACKET: CadDocument = {
  parameters: { width: 40, height: 20, thickness: 5, hole_d: 6 },
  features: [
    {
      id: "f1",
      type: "sketch",
      plane: "XY",
      entities: [
        { type: "rectangle", width: "width", height: "height", x: 0, y: 0 },
      ],
    },
    { id: "f2", type: "extrude", sketch: "f1", distance: "thickness", operation: "new" },
    {
      id: "f3",
      type: "sketch",
      plane: "XY",
      entities: [{ type: "circle", radius: 3, x: -12, y: 0 }],
    },
    { id: "f4", type: "extrude", sketch: "f3", distance: "thickness", operation: "cut" },
    {
      id: "f5",
      type: "fillet",
      edges: { kind: "edge", by: "axis", axis: "Z" },
      radius: 2,
    },
  ],
};
