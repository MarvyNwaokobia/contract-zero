import { describe, it, expect } from 'vitest';
import * as THREE from 'three';
import { makeItemMesh, ITEM_MESH_IDS } from '../ItemMesh';

describe('item props', () => {
  it('builds every catalogued prop as named, shadow-casting geometry', () => {
    for (const id of ITEM_MESH_IDS) {
      const g = makeItemMesh(id);
      expect(g.name).toBe(`item-${id}`);
      const meshes: THREE.Mesh[] = [];
      g.traverse((o) => { if ((o as THREE.Mesh).isMesh) meshes.push(o as THREE.Mesh); });
      expect(meshes.length, id).toBeGreaterThan(0);
      expect(meshes.every((m) => m.castShadow), id).toBe(true);
    }
  });

  it('keeps props hand-sized (they sit in crates and on shelves)', () => {
    for (const id of ITEM_MESH_IDS) {
      const size = new THREE.Box3().setFromObject(makeItemMesh(id)).getSize(new THREE.Vector3());
      expect(Math.max(size.x, size.y, size.z), id).toBeLessThan(2);
    }
  });
});
