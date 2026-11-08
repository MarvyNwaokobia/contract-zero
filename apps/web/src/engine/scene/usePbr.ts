import { useMemo } from 'react';
import { useTexture } from '@react-three/drei';
import { useThree } from '@react-three/fiber';
import * as THREE from 'three';

/**
 * Load a Poly Haven (CC0) PBR set as diffuse + normal + roughness.
 *
 * Same convention AshfallCinematic uses: `{base}_diff_1k.jpg`, `{base}_nor_gl_1k.jpg`,
 * `{base}_rough_1k.jpg` under /textures/ashfall. Suspends while loading, so the
 * caller must sit under a <Suspense>.
 *
 * NOTE: drei caches textures by URL, so two calls with the same `base` share the
 * SAME texture objects (and therefore the same `repeat`). Give each surface its
 * own base, or the tiling of one will stomp the other. (Materials built with
 * `makeTriplanarMaterial` are exempt: they never read `repeat`.)
 *
 * The returned object is stable across renders as long as the textures are, which
 * matters because callers memoise materials on it — `useTexture` itself rebuilds
 * its result object every single render, so keying anything on that directly
 * rebuilds it every render too.
 */

const T = '/textures/ashfall';

export type PbrMaps = {
  map: THREE.Texture;
  normalMap: THREE.Texture;
  roughnessMap: THREE.Texture;
};

export function usePbr(base: string, repeat: [number, number]): PbrMaps {
  const maps = useTexture({
    map: `${T}/${base}_diff_1k.jpg`,
    normalMap: `${T}/${base}_nor_gl_1k.jpg`,
    roughnessMap: `${T}/${base}_rough_1k.jpg`,
  }) as unknown as PbrMaps;

  /**
   * Anisotropic filtering, as much of it as the GPU will give (capped at 16, past
   * which nobody can tell and some drivers charge for it anyway).
   *
   * This is the single cheapest thing that can be done for how the ground reads.
   * A floor is viewed at a grazing angle almost everywhere except directly
   * underfoot, and plain trilinear filtering resolves that by dropping to a coarse
   * mip — which is why the ash five metres ahead was a smear. It was pinned at 4;
   * the machines this runs on hand out 16.
   */
  const aniso = Math.min(16, useThree((s) => s.gl.capabilities.getMaxAnisotropy()));

  const { map, normalMap, roughnessMap } = maps;
  return useMemo(() => {
    const configured: PbrMaps = { map, normalMap, roughnessMap };
    for (const [key, tex] of Object.entries(configured) as [keyof PbrMaps, THREE.Texture][]) {
      tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
      tex.repeat.set(repeat[0], repeat[1]);
      tex.colorSpace = key === 'map' ? THREE.SRGBColorSpace : THREE.NoColorSpace;
      // Filtering is a texture PARAMETER, applied when three uploads the texture —
      // raising it on an already-uploaded (drei-cached) texture does nothing until
      // it is re-uploaded. Guarded, so the re-upload happens once and not on every
      // call that shares the map.
      if (tex.anisotropy !== aniso) {
        tex.anisotropy = aniso;
        tex.needsUpdate = true;
      }
    }
    return configured;
    // Keyed on the TEXTURES (stable, cached by URL), not on useTexture's result
    // object (new every render).
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [map, normalMap, roughnessMap, repeat[0], repeat[1], aniso]);
}
