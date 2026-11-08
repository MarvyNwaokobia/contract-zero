import { useMemo } from 'react';
import { useTexture } from '@react-three/drei';
import type * as THREE from 'three';
import type { ImpactTextures } from './ImpactFX';

const VFX = '/textures/vfx';

/**
 * Load the impact sprite set (Kenney, CC0 — see public/textures/vfx/README.md).
 *
 * Exists mostly to hand back a STABLE object. `useTexture` rebuilds its result
 * object on every render even though the textures inside it are cached by URL, so
 * `useMemo(() => new ImpactFX(maps), [maps])` written against it directly would
 * throw away the particle system — and every bullet hole in the level with it — on
 * any re-render of the scene. Keying on the textures themselves fixes that.
 *
 * Suspends while loading, so the caller must sit under a <Suspense>.
 */
export function useImpactTextures(): ImpactTextures {
  const loaded = useTexture({
    spark: `${VFX}/spark.png`,
    smoke: `${VFX}/smoke.png`,
    debris: `${VFX}/debris.png`,
    flash: `${VFX}/flash.png`,
    droplet: `${VFX}/droplet.png`,
  }) as unknown as Record<keyof ImpactTextures, THREE.Texture>;

  const { spark, smoke, debris, flash, droplet } = loaded;
  return useMemo(
    () => ({ spark, smoke, debris, flash, droplet }),
    [spark, smoke, debris, flash, droplet],
  );
}
