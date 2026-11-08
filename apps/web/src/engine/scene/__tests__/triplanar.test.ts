import { describe, it, expect } from 'vitest';
import * as THREE from 'three';
import { makeTriplanarMaterial } from '../triplanar';
import type { PbrMaps } from '../usePbr';

/**
 * These guard the SHADER SURGERY, which is the fragile part of triplanar.ts.
 *
 * Every one of its edits is a string replace against a stock three chunk name
 * (`<map_fragment>`, `<project_vertex>`, …). A replace that misses does not throw
 * and does not warn — three just compiles the untouched shader, and the surface
 * silently goes back to UV mapping. That is exactly the kind of regression a three
 * upgrade causes and nobody notices until a screenshot looks wrong, so it is
 * asserted here rather than left to the eye.
 *
 * No WebGL is involved: `onBeforeCompile` is a pure string transform, so it can be
 * handed a fake shader and the result inspected.
 */

function maps(): PbrMaps {
  return { map: new THREE.Texture(), normalMap: new THREE.Texture(), roughnessMap: new THREE.Texture() };
}

/** The chunks triplanar.ts rewrites, as three hands them over. */
function fakeShader() {
  return {
    uniforms: {} as Record<string, { value: unknown }>,
    vertexShader: '#include <common>\nvoid main() {\n#include <begin_vertex>\n#include <project_vertex>\n}',
    fragmentShader: '#include <common>\nvoid main() {\n#include <map_fragment>\n#include <roughnessmap_fragment>\n#include <normal_fragment_maps>\n}',
  };
}

function compile(mat: THREE.MeshStandardMaterial) {
  const shader = fakeShader();
  mat.onBeforeCompile(shader as unknown as THREE.WebGLProgramParametersWithUniforms, null as never);
  return shader;
}

describe('makeTriplanarMaterial', () => {
  it('replaces every chunk it targets — none of the string edits silently miss', () => {
    const mat = makeTriplanarMaterial(maps(), {}, { metresPerTile: 1.7 });
    const s = compile(mat);

    expect(s.vertexShader).toContain('vTriPos');
    expect(s.vertexShader).toContain('vTriDepth');
    expect(s.fragmentShader).not.toContain('#include <map_fragment>');
    expect(s.fragmentShader).not.toContain('#include <roughnessmap_fragment>');
    expect(s.fragmentShader).not.toContain('#include <normal_fragment_maps>');
    expect(s.fragmentShader).toContain('texture2D( map,');
    mat.dispose();
  });

  it('sizes the texture in metres, not in UVs', () => {
    const mat = makeTriplanarMaterial(maps(), {}, { metresPerTile: 2.5 });
    const s = compile(mat);
    // The shader multiplies by 1/metres rather than dividing, per fragment.
    expect(s.uniforms.uTriScale.value).toBeCloseTo(1 / 2.5);
    // The world-position wrap has to stay an exact multiple of the tile, or the
    // seam where it wraps becomes visible.
    expect((s.uniforms.uTriWrap.value as number) % 2.5).toBeCloseTo(0);
    mat.dispose();
  });

  it('compiles the extra octaves in only when they are asked for', () => {
    const plain = makeTriplanarMaterial(maps(), {}, {});
    const rich = makeTriplanarMaterial(maps(), {}, { detail: 5.7, macro: 0.13 });

    // The modulation block is absent entirely, not just multiplied by zero — a
    // surface that doesn't want it pays nothing for it.
    expect(compile(plain).fragmentShader).not.toContain('triOctUv');
    const s = compile(rich).fragmentShader;
    expect(s).toContain('triOctUv * uTriDetail');
    expect(s).toContain('triOctUv * uTriMacro');
    // Both octaves modulate what was already sampled rather than replacing it.
    expect(s).toContain('diffuseColor.rgb *=');

    plain.dispose();
    rich.dispose();
  });

  it('the detail octave costs one fetch, not three, even in blend mode', () => {
    const s = compile(makeTriplanarMaterial(maps(), {}, { blend: true, detail: 5.7 })).fragmentShader;
    // Blend cross-fades three projections for the SURFACE...
    expect(s).toContain('triSample( map,');
    // ...but the detail modulation is taken off the dominant axis alone.
    expect(s).toContain('triAxis( triOctN )');
  });

  it('gives materials that compile different shaders different cache keys', () => {
    // three keys its compiled-program cache on material properties, which cannot
    // see onBeforeCompile. Without distinct keys, two of these would be handed each
    // other's program and render as the wrong thing.
    const keys = [
      makeTriplanarMaterial(maps(), {}, {}),
      makeTriplanarMaterial(maps(), {}, { blend: true }),
      makeTriplanarMaterial(maps(), {}, { detail: 5 }),
      makeTriplanarMaterial(maps(), {}, { macro: 0.1 }),
      makeTriplanarMaterial(maps(), {}, { detail: 5, macro: 0.1 }),
      makeTriplanarMaterial(maps(), {}, { blend: true, detail: 5, macro: 0.1 }),
    ].map((m) => {
      const k = m.customProgramCacheKey();
      m.dispose();
      return k;
    });

    expect(new Set(keys).size).toBe(keys.length);
  });

  it('two materials that differ only in TUNING share a program but not uniforms', () => {
    // The opposite risk: a fresh program per wall tint would mean a compile stall
    // every time the zone theme changes. Same source, own uniform values.
    const a = makeTriplanarMaterial(maps(), {}, { metresPerTile: 1.2, detail: 4 });
    const b = makeTriplanarMaterial(maps(), {}, { metresPerTile: 2.4, detail: 4 });
    expect(a.customProgramCacheKey()).toBe(b.customProgramCacheKey());
    expect(compile(a).uniforms.uTriScale.value).not.toBe(compile(b).uniforms.uTriScale.value);
    a.dispose();
    b.dispose();
  });

  it('forces every map to wrap, whatever the caller left them set to', () => {
    // World-space coordinates run to hundreds of tiles across a floor. Clamped
    // textures would smear the last row of texels over all of it, and drei hands
    // out the SAME texture object to every caller — so this cannot be left to
    // whoever loaded it.
    const m = maps();
    m.map.wrapS = m.map.wrapT = THREE.ClampToEdgeWrapping;
    m.normalMap.wrapS = THREE.ClampToEdgeWrapping;
    const mat = makeTriplanarMaterial(m, {}, {});
    for (const tex of [m.map, m.normalMap, m.roughnessMap]) {
      expect(tex.wrapS).toBe(THREE.RepeatWrapping);
      expect(tex.wrapT).toBe(THREE.RepeatWrapping);
    }
    mat.dispose();
  });
});
