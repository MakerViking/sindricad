// Ivy Bridge draws MSAA wrong (Chromium bug 116370; Doug's HD 4000). The match
// runs on WebKit's GL_RENDERER string, so it has to catch Mesa's spellings and
// leave every other Intel generation alone.
import { describe, it, expect, vi } from "vitest";
import { msaaBroken } from "./gpuQuirks";

describe("msaaBroken", () => {
  it("matches Ivy Bridge as Mesa and others name it", () => {
    for (const r of [
      "Mesa Intel(R) HD Graphics 4000 (IVB GT2)",
      "Mesa Intel(R) HD Graphics 2500 (IVB GT1)",
      "Mesa DRI Intel(R) Ivybridge Mobile",
      "Intel(R) HD Graphics 4000",
    ]) expect(msaaBroken(r), r).toBe(true);
  });

  it("leaves other GPUs, Intel included, alone", () => {
    for (const r of [
      "Mesa Intel(R) HD Graphics 4600 (HSW GT2)",
      "Mesa Intel(R) UHD Graphics 620 (KBL GT2)",
      "Mesa Intel(R) HD Graphics 3000 (SNB GT2)",
      "AMD Radeon RX 6900 XT (radeonsi, navi21, ACO)",
      "llvmpipe (LLVM 22.1.8, 256 bits)",
      "NVIDIA GeForce RTX 3060/PCIe/SSE2",
    ]) expect(msaaBroken(r), r).toBe(false);
    expect(msaaBroken(null)).toBe(false);
    expect(msaaBroken("")).toBe(false);
  });
});

describe("graphics compatibility switches", () => {
  it("remember what the user turned on, and nothing that is not a switch", async () => {
    const store = new Map<string, string>();
    vi.stubGlobal("localStorage", { getItem: (k: string) => store.get(k) ?? null, setItem: (k: string, v: string) => void store.set(k, v) });
    const q = await import("./gpuQuirks");
    expect([...q.compatSwitches()]).toEqual([]);
    q.setCompatSwitch("plainDepth", true);
    q.setCompatSwitch("frontFaces", true);
    q.setCompatSwitch("plainDepth", false);
    expect([...q.compatSwitches()]).toEqual(["frontFaces"]);
    store.set("sindri.gpu.compat", JSON.stringify(["frontFaces", "rm -rf", 3]));
    expect([...q.compatSwitches()]).toEqual(["frontFaces"]);
    store.set("sindri.gpu.compat", "not json");
    expect([...q.compatSwitches()]).toEqual([]);
    vi.unstubAllGlobals();
  });

  it("shader offset everywhere: by the switch, or by the self-test", async () => {
    const store = new Map<string, string>();
    vi.stubGlobal("localStorage", { getItem: (k: string) => store.get(k) ?? null, setItem: (k: string, v: string) => void store.set(k, v) });
    const q = await import("./gpuQuirks");
    expect(q.shaderOffsetEverywhere()).toBe(false);
    q.setAutoShaderOffset(true);
    expect(q.shaderOffsetEverywhere()).toBe(true);
    q.setAutoShaderOffset(false);
    q.setCompatSwitch("shaderOffset", true);
    expect(q.shaderOffsetEverywhere()).toBe(true);
    vi.unstubAllGlobals();
  });
});
