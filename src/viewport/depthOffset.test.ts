// Log depth (Doug's squiggles, second round) only works if the faces still sit
// behind their own edge lines, which the hardware polygon offset stops doing
// once a shader writes gl_FragDepth. These pin the shader half of that.
import { describe, it, expect } from "vitest";
import * as THREE from "three";
import { installLogDepthOffset, withDepthOffset, LOG_DEPTH_UNIT, LINEAR_DEPTH_UNIT } from "./depthOffset";

describe("the shader depth offset", () => {
  it("replaces three's log-depth chunk with one that writes the offset in perspective only", () => {
    installLogDepthOffset();
    const chunk = THREE.ShaderChunk.logdepthbuf_fragment;
    expect(chunk).toContain("gl_FragDepth = sindriDepth");
    expect(chunk).toMatch(/if \( sindriPersp != 0\.0 \) sindriDepth \+= SINDRI_DEPTH_OFFSET_FACTOR \* sindriSlope/);
    // glPolygonOffset's slope is the larger screen slope, not fwidth's sum
    expect(chunk).toContain("max( abs( dFdx( sindriDepth ) ), abs( dFdy( sindriDepth ) ) )");
    // ortho keeps three's gl_FragCoord.z, which carries the hardware offset
    expect(chunk).toContain("vIsPerspective == 0.0 ? gl_FragCoord.z");
  });

  it("keeps the hardware offset for ortho and adds the shader one, as GLSL floats", () => {
    const m = withDepthOffset(new THREE.MeshStandardMaterial());
    expect(m.polygonOffset).toBe(true);
    expect([m.polygonOffsetFactor, m.polygonOffsetUnits]).toEqual([1, 1]);
    const d = (m as unknown as { defines: Record<string, string> }).defines;
    expect(d.SINDRI_DEPTH_OFFSET).toBe("");
    expect(d.SINDRI_DEPTH_OFFSET_FACTOR).toBe("1.0");
    expect(Number(d.SINDRI_DEPTH_OFFSET_UNITS)).toBe(LOG_DEPTH_UNIT);
    expect(d.SINDRI_DEPTH_OFFSET_UNITS).toMatch(/[.e]/);
  });

  it("keeps a material's own defines", () => {
    const m = withDepthOffset(new THREE.ShaderMaterial({ defines: { KEEP: "1" } }), 2, 3);
    expect(m.defines.KEEP).toBe("1");
    expect(m.defines.SINDRI_DEPTH_OFFSET_FACTOR).toBe("2.0");
  });
});

describe("the offset where the hardware one cannot be trusted", () => {
  it("turns the hardware offset off and writes it in the shader in both projections", async () => {
    const q = await import("./gpuQuirks");
    q.setAutoShaderOffset(true);
    try {
      const m = withDepthOffset(new THREE.MeshStandardMaterial());
      expect(m.polygonOffset).toBe(false);
      const d = (m as unknown as { defines: Record<string, string> }).defines;
      expect(d.SINDRI_DEPTH_OFFSET_ALWAYS).toBe("");
      expect(Number(d.SINDRI_DEPTH_OFFSET_LINEAR_UNITS)).toBe(LINEAR_DEPTH_UNIT);
      installLogDepthOffset();
      // the chunk also runs WITHOUT log depth when the offset is everywhere
      expect(THREE.ShaderChunk.logdepthbuf_fragment).toContain("defined( USE_LOGARITHMIC_DEPTH_BUFFER ) || defined( SINDRI_DEPTH_OFFSET_ALWAYS )");
    } finally {
      q.setAutoShaderOffset(false);
    }
  });
});
