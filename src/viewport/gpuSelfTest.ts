// i18n-ignore-file GPU diagnostics only: English so a bug report stays searchable
// A battery of one-pixel draws that says how THIS machine's GL really behaves.
//
// Doug's Intel HD 4000 (Ivy Bridge, Mesa crocus) kept stair-steps and ghost edges
// through three fixes, in Ortho too, and his depth probe drew NOTHING at all
// ("controls: behind=rgb 0,0,0 front=rgb 0,0,0"). Guessing from a rig that
// cannot run his driver had stopped paying. Each test here isolates one thing a
// viewport depends on: that a draw lands, that a depth comparison works, that a
// depth-only clear clears, how many bits resolve, how big polygon offset really
// is (units and slope), and whether a depth written by the shader is respected.
// The answers go into every bug report (scene.ts), and a polygon offset that
// is far off switches the viewport to the shader's own offset (gpuQuirks.ts).

const VS = `#version 300 es
in vec3 p;
void main() { gl_Position = vec4(p, 1.0); }`;
const FS = `#version 300 es
precision highp float;
uniform vec4 c;
uniform float fd; // < 0: leave the depth alone; otherwise write it
out vec4 o;
void main() {
  o = c;
  gl_FragDepth = fd < 0.0 ? gl_FragCoord.z : fd;
}`;
// A shader that writes gl_FragDepth on one path writes it on every path, so the
// plain draws use a second program that never touches it.
const FS_PLAIN = `#version 300 es
precision highp float;
uniform vec4 c;
out vec4 o;
void main() { o = c; }`;

export interface SelfTest {
  /** a draw with no depth test lands in the pixel */
  draw: string;
  /** nearer wins and farther loses with LESS */
  less: string;
  /** a clear of depth alone (stencil left) really resets depth */
  clearDepthOnly: string;
  /** smallest window-depth step that still resolves, as k in 2^-k */
  bits: number | null;
  /** polygon offset of (0, 1), as k: the offset is about 2^-k of the range */
  unitsK: number | null;
  /** polygon offset of (1, 0) on a known slope, as measured / expected */
  slopeRatio: number | null;
  /** a gl_FragDepth write decides the test, and polygon offset does not move it */
  fragDepth: string;
  error?: string;
}

/** window depth -> NDC */
const ndc = (w: number) => w * 2 - 1;

/** Run the battery on `fb` (null = the canvas). Leaves GL state changed: the
 *  caller resets its tracking (three: renderer.resetState()). */
export function runSelfTest(gl: WebGL2RenderingContext, fb: WebGLFramebuffer | null = null): SelfTest {
  const out: SelfTest = { draw: "?", less: "?", clearDepthOnly: "?", bits: null, unitsK: null, slopeRatio: null, fragDepth: "?" };
  const made: { progs: WebGLProgram[]; shaders: WebGLShader[] } = { progs: [], shaders: [] };
  const program = (fs: string) => {
    const sh = (type: number, src: string) => {
      const s = gl.createShader(type)!;
      gl.shaderSource(s, src);
      gl.compileShader(s);
      made.shaders.push(s);
      return s;
    };
    const p = gl.createProgram()!;
    gl.attachShader(p, sh(gl.VERTEX_SHADER, VS));
    gl.attachShader(p, sh(gl.FRAGMENT_SHADER, fs));
    gl.bindAttribLocation(p, 0, "p");
    gl.linkProgram(p);
    made.progs.push(p);
    if (!gl.getProgramParameter(p, gl.LINK_STATUS)) throw new Error(`link: ${(gl.getProgramInfoLog(p) || "no log").slice(0, 60)}`);
    return p;
  };
  const buf = gl.createBuffer();
  const vao = gl.createVertexArray();
  try {
    const plain = program(FS_PLAIN), writer = program(FS);
    gl.bindFramebuffer(gl.FRAMEBUFFER, fb);
    gl.bindVertexArray(vao);
    gl.bindBuffer(gl.ARRAY_BUFFER, buf);
    gl.enableVertexAttribArray(0);
    gl.vertexAttribPointer(0, 3, gl.FLOAT, false, 0, 0);
    gl.viewport(0, 0, 1, 1);
    gl.disable(gl.SCISSOR_TEST);
    gl.disable(gl.BLEND);
    gl.disable(gl.CULL_FACE);
    gl.disable(gl.STENCIL_TEST);
    gl.disable(gl.POLYGON_OFFSET_FILL);
    gl.colorMask(true, true, true, true);
    gl.depthMask(true);
    gl.depthFunc(gl.LESS);
    gl.depthRange(0, 1);
    const px = new Uint8Array(4);

    /** one triangle over the pixel; window depth `w` at the pixel centre, rising by `slope` per pixel in x */
    const tri = (w: number, slope = 0) => {
      // the 1x1 viewport spans NDC x -1..1, so one pixel is 2 NDC units: dz_ndc/dx_ndc = slope
      const z = (x: number) => ndc(w) + slope * x;
      gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, z(-1), 3, -1, z(3), -1, 3, z(-1)]), gl.DYNAMIC_DRAW);
    };
    const draw = (prog: WebGLProgram, w: number, rgb: [number, number], opts: { slope?: number; fd?: number } = {}) => {
      gl.useProgram(prog);
      gl.uniform4f(gl.getUniformLocation(prog, "c"), rgb[0], rgb[1], 0, 1);
      if (prog === writer) gl.uniform1f(gl.getUniformLocation(prog, "fd"), opts.fd ?? -1);
      tri(w, opts.slope ?? 0);
      gl.drawArrays(gl.TRIANGLES, 0, 3);
    };
    const clearAll = () => {
      gl.clearColor(0, 0, 0, 1);
      gl.clearDepth(1);
      gl.clearStencil(0);
      gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT | gl.STENCIL_BUFFER_BIT);
    };
    const read = () => {
      gl.readPixels(0, 0, 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, px);
      return px[1]! > 128 && px[0]! < 128 ? "green" : px[0]! > 128 && px[1]! < 128 ? "red" : `rgb${px[0]},${px[1]},${px[2]}`;
    };
    const RED: [number, number] = [1, 0], GREEN: [number, number] = [0, 1];

    // draw: no depth test at all
    clearAll();
    gl.disable(gl.DEPTH_TEST);
    draw(plain, 0.5, RED);
    out.draw = read() === "red" ? "ok" : read();
    gl.enable(gl.DEPTH_TEST);

    // less: nearer green wins, farther green loses
    clearAll(); draw(plain, 0.5, RED); draw(plain, 0.4, GREEN);
    const near = read();
    clearAll(); draw(plain, 0.5, RED); draw(plain, 0.6, GREEN);
    const far = read();
    out.less = near === "green" && far === "red" ? "ok" : `near=${near} far=${far}`;

    // a depth-only clear (stencil untouched): red at 0.5, clear depth, green at 0.6 must now pass
    clearAll(); draw(plain, 0.5, RED);
    gl.clear(gl.DEPTH_BUFFER_BIT);
    draw(plain, 0.6, GREEN);
    const cd = read();
    out.clearDepthOnly = cd === "green" ? "ok" : cd === "red" ? "depth kept" : cd;

    const base = 0.75; // a fixed-point and a float step both mean 2^-k here
    /** green at `base + d` against red at `base` drawn under `prep`: does green win? */
    const greenBeats = (d: number, prep: () => void, redSlope = 0) => {
      clearAll();
      prep();
      draw(plain, base, RED, { slope: redSlope });
      gl.disable(gl.POLYGON_OFFSET_FILL);
      draw(plain, base + d, GREEN);
      return read() === "green";
    };
    const none = () => gl.disable(gl.POLYGON_OFFSET_FILL);
    // bits: the finest step a nearer quad still wins by
    let bits: number | null = null;
    for (let k = 8; k <= 24; k++) {
      if (!greenBeats(-(2 ** -k), none)) break;
      bits = k;
    }
    out.bits = bits;

    // units: red pushed back by polygonOffset(0, 1); green behind red by 2^-k wins once 2^-k < the push
    const units = () => { gl.enable(gl.POLYGON_OFFSET_FILL); gl.polygonOffset(0, 1); };
    for (let k = 4; k <= 26; k++) {
      if (greenBeats(2 ** -k, units)) { out.unitsK = k; break; }
    }

    // slope: red on a known slope, pushed back by polygonOffset(1, 0) = 1 x the slope
    const slope = 2 ** -10;
    const factor = () => { gl.enable(gl.POLYGON_OFFSET_FILL); gl.polygonOffset(1, 0); };
    let lastWin: number | null = null;
    for (let k = 4; k <= 22; k++) {
      // green wins while its gap is under the push; the largest such gap is the push
      if (greenBeats(2 ** -k, factor, slope)) { lastWin = 2 ** -k; break; }
    }
    out.slopeRatio = lastWin === null ? null : +(lastWin / slope).toFixed(3);

    // fragDepth: green geometry at 0.6 writes depth 0.4, so it beats red at 0.5;
    // with a huge polygon offset on it too, it must STILL win (a written depth takes no offset)
    clearAll(); draw(plain, 0.5, RED); draw(writer, 0.6, GREEN, { fd: 0.4 });
    const fdPlain = read();
    clearAll(); draw(plain, 0.5, RED);
    gl.enable(gl.POLYGON_OFFSET_FILL); gl.polygonOffset(0, 2 ** 22);
    draw(writer, 0.6, GREEN, { fd: 0.4 });
    gl.disable(gl.POLYGON_OFFSET_FILL);
    const fdOffset = read();
    out.fragDepth = fdPlain !== "green" ? `ignored (${fdPlain})` : fdOffset !== "green" ? "offset added to it" : "ok";
  } catch (e) {
    out.error = String((e as Error)?.message ?? e).slice(0, 80); // a diagnostic must never break startup
  } finally {
    for (const p of made.progs) gl.deleteProgram(p);
    for (const s of made.shaders) gl.deleteShader(s);
    gl.deleteBuffer(buf);
    gl.deleteVertexArray(vao);
    gl.disable(gl.POLYGON_OFFSET_FILL);
  }
  return out;
}

/** The same battery on a framebuffer of our own (24-bit depth + stencil, the
 *  format the canvas asks for), to tell the canvas apart from the driver. */
export function runSelfTestOffscreen(gl: WebGL2RenderingContext): SelfTest {
  const fb = gl.createFramebuffer()!;
  const col = gl.createRenderbuffer()!, ds = gl.createRenderbuffer()!;
  try {
    gl.bindFramebuffer(gl.FRAMEBUFFER, fb);
    gl.bindRenderbuffer(gl.RENDERBUFFER, col);
    gl.renderbufferStorage(gl.RENDERBUFFER, gl.RGBA8, 4, 4);
    gl.framebufferRenderbuffer(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.RENDERBUFFER, col);
    gl.bindRenderbuffer(gl.RENDERBUFFER, ds);
    gl.renderbufferStorage(gl.RENDERBUFFER, gl.DEPTH24_STENCIL8, 4, 4);
    gl.framebufferRenderbuffer(gl.FRAMEBUFFER, gl.DEPTH_STENCIL_ATTACHMENT, gl.RENDERBUFFER, ds);
    return runSelfTest(gl, fb);
  } finally {
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    gl.deleteFramebuffer(fb);
    gl.deleteRenderbuffer(col);
    gl.deleteRenderbuffer(ds);
  }
}

/** One line per framebuffer for the report. */
export function describe(t: SelfTest): string {
  const k = (v: number | null) => (v === null ? "?" : `2^-${v}`);
  return `draw ${t.draw}, less ${t.less}, depth-only clear ${t.clearDepthOnly}, resolves ${t.bits ?? "?"} bits, `
    + `offset units ${k(t.unitsK)}, offset slope x${t.slopeRatio ?? "?"}, fragDepth ${t.fragDepth}`
    + (t.error ? `, error: ${t.error}` : "");
}

/** Is this polygon offset far enough from what GL specifies that the viewport
 *  should stop relying on it? Units of (0, 1) are one depth step: 2^-24 for 24
 *  bits, 2^-16 for 16. Slope (1, 0) is 1x. Unknown is not "wrong". */
export function offsetIsWrong(t: SelfTest): boolean {
  const unitsOff = t.unitsK !== null && t.unitsK < 14; // a push of 2^-13 or more: 8x a 16-bit step
  const slopeOff = t.slopeRatio !== null && (t.slopeRatio > 4 || t.slopeRatio < 0.25);
  return unitsOff || slopeOff;
}
