// Depth that does not hang on the near plane (Doug's squiggles, second round).
//
// 0.1.265 aimed the perspective near plane at the nearest drawn object
// (depthRange.ts), which buys precision only while nothing drawn is close to
// the camera. One sketch, plane, gizmo or grid line near the eye pulls near
// back to 0.1 mm for the whole frame, and on a graphics stack whose depth is
// shallower than it reports (Doug's says 24 bits and draws like 16), faces and
// edges a few tenths of a mm apart take turns in front again: stair-stepped
// rims, hidden edges bleeding through (.fable/doug-squiggles2/RESULT.md).
//
// A logarithmic depth buffer gives about the same RELATIVE precision at every
// distance whatever near is, so the near plane stops mattering. Its one catch:
// a shader that writes gl_FragDepth loses the hardware polygon offset, and the
// model's faces rely on it to sit behind their own edge lines. So the offset is
// redone here, in the shader, the way glPolygonOffset defines it: `factor`
// times the depth slope across one pixel, plus `units` of the smallest step.
//
// Ortho is left exactly as it was. three writes gl_FragCoord.z there, and by
// the GLSL ES 3.00 spec that is the depth the fragment would have had with no
// write at all, hardware polygon offset included.
import * as THREE from "three";
import { shaderOffsetEverywhere } from "./gpuQuirks";

/** One offset "unit" in the log depth the shader writes: one step of a 16-bit
 *  buffer, so it still separates a face from its edge where the real buffer is
 *  that shallow. With far at 10 m it pushes a face back by 0.014% of its
 *  distance, about a sixth of a pixel at a 45° field of view. */
export const LOG_DEPTH_UNIT = 1 / 65536;

/** One offset "unit" in plain (non-log) window depth, used when the shader
 *  writes the offset in ortho or without log depth (shaderOffsetEverywhere):
 *  four steps of a 24-bit buffer, what glPolygonOffset's units of 1 mean there
 *  give or take a driver's rounding. */
export const LINEAR_DEPTH_UNIT = 1 / 4194304;

const CHUNK = /* glsl */ `
#if defined( USE_LOGARITHMIC_DEPTH_BUFFER ) || defined( SINDRI_DEPTH_OFFSET_ALWAYS )
	#if defined( USE_LOGARITHMIC_DEPTH_BUFFER )
	float sindriPersp = vIsPerspective;
	// three's own line, kept: a strict == 1.0 test is noisy on some platforms (three #17623)
	float sindriDepth = vIsPerspective == 0.0 ? gl_FragCoord.z : log2( vFragDepth ) * logDepthBufFC * 0.5;
	#else
	float sindriPersp = 0.0; // plain depth: gl_FragCoord.z in both projections
	float sindriDepth = gl_FragCoord.z;
	#endif
	#ifdef SINDRI_DEPTH_OFFSET
		// glPolygonOffset's slope term is the LARGER of the two screen-space
		// slopes; fwidth() is their sum, up to twice that
		float sindriSlope = max( abs( dFdx( sindriDepth ) ), abs( dFdy( sindriDepth ) ) );
		#ifdef SINDRI_DEPTH_OFFSET_ALWAYS
		// the hardware offset is off (gpuQuirks.ts): this is the only one, in both projections
		sindriDepth += SINDRI_DEPTH_OFFSET_FACTOR * sindriSlope + ( sindriPersp != 0.0 ? SINDRI_DEPTH_OFFSET_UNITS : SINDRI_DEPTH_OFFSET_LINEAR_UNITS );
		#else
		if ( sindriPersp != 0.0 ) sindriDepth += SINDRI_DEPTH_OFFSET_FACTOR * sindriSlope + SINDRI_DEPTH_OFFSET_UNITS;
		#endif
	#endif
	gl_FragDepth = sindriDepth;
#endif
`;

/** Replace three's log-depth fragment chunk with one that can carry an offset.
 *  Must run before the first material compiles; scene.ts calls it before it
 *  makes the renderer. */
export function installLogDepthOffset(): void {
  THREE.ShaderChunk.logdepthbuf_fragment = CHUNK;
}

/** GLSL wants a decimal point in a float literal. */
function glslFloat(x: number): string {
  const s = String(x);
  return /[.e]/.test(s) ? s : `${s}.0`;
}

/** Give `mat` a polygon offset that survives log depth: the hardware one
 *  (still what ortho uses) and the same offset written by the shader for
 *  perspective. Use it everywhere a material sets polygonOffset.
 *
 *  Where the hardware offset cannot be trusted (gpuQuirks.ts
 *  shaderOffsetEverywhere: the startup self-test measured it far off, or the
 *  user switched it), the shader writes the offset in BOTH projections and the
 *  hardware one is off. */
export function withDepthOffset<M extends THREE.Material>(mat: M, factor = 1, units = 1): M {
  const everywhere = shaderOffsetEverywhere();
  mat.polygonOffset = !everywhere;
  mat.polygonOffsetFactor = factor;
  mat.polygonOffsetUnits = units;
  // `defines` is read by three for every material, but its type only declares it on ShaderMaterial
  const m = mat as THREE.Material & { defines?: Record<string, unknown> };
  m.defines = {
    ...(m.defines ?? {}),
    SINDRI_DEPTH_OFFSET: "",
    SINDRI_DEPTH_OFFSET_FACTOR: glslFloat(factor),
    SINDRI_DEPTH_OFFSET_UNITS: glslFloat(units * LOG_DEPTH_UNIT),
    ...(everywhere ? { SINDRI_DEPTH_OFFSET_ALWAYS: "", SINDRI_DEPTH_OFFSET_LINEAR_UNITS: glslFloat(units * LINEAR_DEPTH_UNIT) } : {}),
  };
  return mat;
}
