import * as THREE from 'three';
import type { PbrMaps } from './usePbr';

/**
 * World-space (triplanar) texturing for MeshStandardMaterial.
 *
 * WHY: every wall and crate in the FPS scene is the SAME unit cube scaled to size
 * (see UNIT_BOX in ValorScene — one shared geometry, ~10 GPU buffers saved per
 * room). A unit cube carries unit UVs, so a 6m × 3m wall and a 1m crate both map
 * the texture 0..1 across their whole face: the brick on the long wall is stretched
 * six times wider than the brick on the crate beside it, and every face has a
 * different texel density. No amount of `repeat` fixes that, because `repeat` is a
 * property of the TEXTURE and drei hands the same texture object to every mesh.
 *
 * Triplanar drops UVs entirely and derives the texture coordinate from the WORLD
 * POSITION of the fragment, so texel density is constant everywhere by construction:
 * `metresPerTile` metres of wall always gets exactly one tile of brick, whatever the
 * mesh it belongs to was scaled by. Two more things fall out of it for free:
 *
 *  - the drei "shared texture, shared repeat" footgun in usePbr goes away — nothing
 *    reads `texture.repeat` any more, so two surfaces can share one base map;
 *  - the endless floor plane can teleport along Z to follow the player without the
 *    ground texture visibly jumping, because the texture is pinned to the world, not
 *    to the plane. (The repeat-alignment arithmetic that used to hide that jump is
 *    no longer load-bearing.)
 *
 * TWO MODES, and the cheap one is the one we want here:
 *
 *  - `hard` (default) picks the single axis the surface most faces and projects along
 *    it. One texture fetch per map — exactly what plain UV sampling costs. For an
 *    axis-aligned box it is not an approximation: the face IS perpendicular to one
 *    axis, so the projection is exact and there is no seam to blend away.
 *  - `blend` samples all three axes and cross-fades by the surface normal. Three
 *    fetches per map, needed only for curved or angled geometry (a rotated prop, a
 *    rubble pile) where hard projection would smear across the transition.
 *
 * Normal maps are handled properly in both modes rather than being passed through
 * with the mesh's tangents (which describe the WRONG parameterisation once the UVs
 * are gone): `hard` rebuilds the tangent frame of the chosen axis, `blend` uses the
 * standard whiteout blend.
 *
 * TWO EXTRA OCTAVES fix what one tiling texture can never do on its own, and they
 * are the reason a 1k map holds up on a pillar you can put your face against:
 *
 *  - `detail` samples the SAME map again several times finer and modulates the base
 *    with it, fading out with distance. Up close, a 1k texture stretched over
 *    ~2 metres is being magnified perhaps eight times — every texel is a soft blob,
 *    which is exactly the mush the wood pillar in the compound showed. The fine
 *    octave puts grain back at the pixel scale, so the surface reads as material
 *    rather than as a blurred photograph, without loading a second texture.
 *  - `macro` samples it MUCH coarser and tints by that, which breaks up the obvious
 *    repeat over a long wall or the floor. Tiling reads as tiling because every tile
 *    has identical average brightness; a slow blotch across many tiles hides the grid
 *    the eye was locking onto.
 *
 * Both are multiplicative deviations around mid-grey (`1 + (sample - 0.5) * amount`),
 * so they add texture without shifting the surface's overall exposure, and both cost
 * one fetch each on the diffuse only — the normal and roughness maps stay single-tap.
 */

export interface TriplanarOptions {
  /** World metres covered by one tile of the texture. Lower = finer detail. */
  metresPerTile?: number;
  /** Cross-fade all three axes instead of picking one. 3x the texture fetches; only
   *  worth it on geometry that is not axis-aligned. */
  blend?: boolean;
  /** How tightly `blend` favours the dominant axis (higher = narrower seam). */
  sharpness?: number;
  /** Frequency of the close-range detail octave, as a multiple of the base tiling.
   *  Wants to be non-integer so it never lines up with the base. 0 = off. */
  detail?: number;
  /** How hard the detail octave bites, 0..1. */
  detailAmount?: number;
  /** View distance in metres over which detail fades out: [full, gone]. Past `gone`
   *  the octave is below a pixel anyway, and sampling it there is just aliasing. */
  detailFade?: [number, number];
  /** Frequency of the macro-variation octave, as a fraction of the base tiling
   *  (0.1 ≈ one blotch per ten tiles). 0 = off. */
  macro?: number;
  /** How strongly macro variation tints, 0..1. */
  macroAmount?: number;
}

type StandardParams = THREE.MeshStandardMaterialParameters;

/**
 * A MeshStandardMaterial that samples `maps` by world position. Keeps the whole
 * standard pipeline — lights, shadows, fog, tone mapping — because it patches the
 * stock shader rather than replacing it.
 */
export function makeTriplanarMaterial(
  maps: PbrMaps,
  params: StandardParams = {},
  opts: TriplanarOptions = {},
): THREE.MeshStandardMaterial {
  const metresPerTile = opts.metresPerTile ?? 2;
  const blend = opts.blend ?? false;
  const sharpness = opts.sharpness ?? 8;
  const detail = opts.detail ?? 0;
  const macro = opts.macro ?? 0;
  const detailFade = opts.detailFade ?? [7, 16];

  // Damped image-based lighting on every world surface.
  //
  // `scene.environment` (zoneEnvironment.ts) runs at full strength so the weapon —
  // authored at envMapIntensity 1.8 and the reason IBL exists here at all — reads
  // as steel. But these are the compound: walls, floor, cover, clutter, at
  // roughness 1 / metalness 0, where an environment map contributes almost pure
  // diffuse irradiance. At full strength that is a second ambient light over every
  // surface in the level, which lifts the blacks and flattens the hand-tuned zone
  // lighting the whole scene is built around.
  //
  // Damping here rather than globally is what lets metal and matte respond
  // differently to the same sky, which is the entire point of the environment map.
  // Overridable per material: it is only a default in the spread.
  const mat = new THREE.MeshStandardMaterial({ envMapIntensity: 0.25, ...maps, ...params });

  // Texture coords are computed in the shader, so a shared texture's `repeat` is
  // dead state — clear it so nobody later "fixes" the tiling by setting it and
  // wonders why nothing moved.
  for (const tex of [maps.map, maps.normalMap, maps.roughnessMap]) {
    tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
  }

  const uniforms = {
    // 1/metres: a multiply in the shader instead of a divide, per fragment.
    uTriScale: { value: 1 / metresPerTile },
    // Wrap world position before scaling so an endless run walking 500m down -Z
    // doesn't hand the sampler coordinates big enough to lose precision (texture
    // swimming). An exact multiple of the tile size, so the wrap is seamless.
    uTriWrap: { value: metresPerTile * 32 },
    uTriSharpness: { value: sharpness },
    // Both extra octaves are expressed relative to the base tiling, so retuning
    // `metresPerTile` keeps their relationship to it and nothing has to be redialled.
    uTriDetail: { value: detail },
    uTriDetailAmt: { value: opts.detailAmount ?? 0.7 },
    uTriFade: { value: new THREE.Vector2(detailFade[0], detailFade[1]) },
    uTriMacro: { value: macro },
    uTriMacroAmt: { value: opts.macroAmount ?? 0.34 },
  };

  const defines = [
    blend ? 'blend' : 'hard',
    detail > 0 ? 'detail' : '',
    macro > 0 ? 'macro' : '',
  ].filter(Boolean).join('+');

  mat.onBeforeCompile = (shader) => {
    Object.assign(shader.uniforms, uniforms);

    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', `#include <common>\n${VARYINGS}`)
      .replace(
        '#include <begin_vertex>',
        `#include <begin_vertex>
        vTriPos = ( modelMatrix * vec4( transformed, 1.0 ) ).xyz;
        // Non-uniform scale is fine here: every mesh using this material is an
        // axis-aligned box or plane, so scaling a face normal cannot rotate it.
        vTriNrm = normalize( mat3( modelMatrix ) * objectNormal );`,
      )
      // <project_vertex> is where three builds mvPosition; -z out of it is the
      // view distance the detail octave fades over.
      .replace('#include <project_vertex>', '#include <project_vertex>\nvTriDepth = - mvPosition.z;');

    // The hard-projection helpers are always present, even in `blend` mode: the
    // detail and macro octaves are a MODULATION, not the surface, so taking them
    // off the dominant axis alone is indistinguishable and keeps them at one fetch
    // apiece instead of three.
    const helpers = blend ? `${HARD_HELPERS}\n${BLEND_HELPERS}` : HARD_HELPERS;
    const modulation = detail > 0 || macro > 0
      ? OCTAVES.replace('/*DETAIL*/', detail > 0 ? DETAIL_OCTAVE : '').replace('/*MACRO*/', macro > 0 ? MACRO_OCTAVE : '')
      : '';

    shader.fragmentShader = shader.fragmentShader
      .replace('#include <common>', `#include <common>\n${VARYINGS}\n${FRAG_UNIFORMS}`)
      // Helpers go in just above main(), where every sampler uniform is declared.
      .replace('void main() {', `${helpers}\nvoid main() {`)
      .replace('#include <map_fragment>', (blend ? BLEND_MAP : HARD_MAP).replace('/*OCTAVES*/', modulation))
      .replace('#include <roughnessmap_fragment>', blend ? BLEND_ROUGH : HARD_ROUGH)
      .replace('#include <normal_fragment_maps>', blend ? BLEND_NORMAL : HARD_NORMAL);
  };

  // three caches compiled programs by material properties, and onBeforeCompile edits
  // are invisible to that key. Without this, a `hard` and a `blend` material with
  // otherwise identical settings would be handed each other's program — and so would
  // two that differ only in which extra octaves they compile in.
  mat.customProgramCacheKey = () => `triplanar:${defines}`;

  return mat;
}

const VARYINGS = /* glsl */`
varying vec3 vTriPos;
varying vec3 vTriNrm;
varying float vTriDepth;
`;

const FRAG_UNIFORMS = /* glsl */`
uniform float uTriScale;
uniform float uTriWrap;
uniform float uTriSharpness;
uniform float uTriDetail;
uniform float uTriDetailAmt;
uniform vec2 uTriFade;
uniform float uTriMacro;
uniform float uTriMacroAmt;

// Wrapped world position, in texture units.
vec3 triPos() {
  return mod( vTriPos, uTriWrap ) * uTriScale;
}
`;

/**
 * Per-axis projections. The sign flips keep opposite faces of a box from mirroring
 * into each other, so a corner reads as two faces of the same wall rather than a
 * fold. Tangent frames below are built to match these exactly (T x B = N).
 */
const HARD_HELPERS = /* glsl */`
// 0 = X-facing, 1 = Y-facing, 2 = Z-facing.
int triAxis( vec3 n ) {
  vec3 a = abs( n );
  if ( a.x >= a.y && a.x >= a.z ) return 0;
  if ( a.y >= a.z ) return 1;
  return 2;
}

vec2 triUv( vec3 p, vec3 n, int axis ) {
  if ( axis == 0 ) return vec2( -sign( n.x ) * p.z, p.y );
  if ( axis == 1 ) return vec2( p.x, -sign( n.y ) * p.z );
  return vec2( sign( n.z ) * p.x, p.y );
}

// Tangent-space normal -> world space, using the tangent frame of the chosen plane.
vec3 triWorldNormal( vec3 mapN, vec3 n, int axis ) {
  if ( axis == 0 ) {
    float s = sign( n.x );
    return vec3( s * mapN.z, mapN.y, -s * mapN.x );
  }
  if ( axis == 1 ) {
    float s = sign( n.y );
    return vec3( mapN.x, s * mapN.z, -s * mapN.y );
  }
  float s = sign( n.z );
  return vec3( s * mapN.x, mapN.y, s * mapN.z );
}
`;

const BLEND_HELPERS = /* glsl */`
vec3 triWeights( vec3 n ) {
  vec3 w = pow( abs( n ), vec3( uTriSharpness ) );
  return w / max( w.x + w.y + w.z, 1e-4 );
}

vec2 triUvX( vec3 p, vec3 n ) { return vec2( -sign( n.x ) * p.z, p.y ); }
vec2 triUvY( vec3 p, vec3 n ) { return vec2( p.x, -sign( n.y ) * p.z ); }
vec2 triUvZ( vec3 p, vec3 n ) { return vec2( sign( n.z ) * p.x, p.y ); }

vec4 triSample( sampler2D t, vec3 p, vec3 n, vec3 w ) {
  return texture2D( t, triUvX( p, n ) ) * w.x
       + texture2D( t, triUvY( p, n ) ) * w.y
       + texture2D( t, triUvZ( p, n ) ) * w.z;
}
`;

// ── Diffuse ────────────────────────────────────────────────────────────────────
// The sampler decodes sRGB in hardware (three picks an sRGB internal format from
// texture.colorSpace), so these reads are already linear, exactly like the stock
// chunk's would be.

const HARD_MAP = /* glsl */`
#ifdef USE_MAP
  vec3 triP = triPos();
  vec3 triN = normalize( vTriNrm );
  int triA = triAxis( triN );
  diffuseColor *= texture2D( map, triUv( triP, triN, triA ) );
  /*OCTAVES*/
#endif
`;

const BLEND_MAP = /* glsl */`
#ifdef USE_MAP
  vec3 triP = triPos();
  vec3 triN = normalize( vTriNrm );
  vec3 triW = triWeights( triN );
  diffuseColor *= triSample( map, triP, triN, triW );
  /*OCTAVES*/
#endif
`;

// ── Extra octaves ──────────────────────────────────────────────────────────────
// Both take the SAME map at a different frequency and modulate what was already
// sampled. Written as a deviation around mid-grey so the surface's average
// brightness survives: a map whose mean is 0.45 shifts the result by 2-3% at these
// amounts, not by the map's whole exposure.
//
// The offsets are there so neither octave lands in phase with the base sample at
// the world origin, which would otherwise put a visible sharp cross right where the
// player starts.

const OCTAVES = /* glsl */`
  vec3 triOctN = normalize( vTriNrm );
  vec2 triOctUv = triUv( triPos(), triOctN, triAxis( triOctN ) );
  /*DETAIL*/
  /*MACRO*/
`;

const DETAIL_OCTAVE = /* glsl */`
  // Below a pixel at range, so it is faded out rather than left to alias.
  float triDetW = ( 1.0 - smoothstep( uTriFade.x, uTriFade.y, vTriDepth ) ) * uTriDetailAmt;
  if ( triDetW > 0.002 ) {
    vec3 triDet = texture2D( map, triOctUv * uTriDetail + vec2( 0.37, 0.11 ) ).rgb;
    diffuseColor.rgb *= 1.0 + ( triDet - 0.5 ) * triDetW;
  }
`;

const MACRO_OCTAVE = /* glsl */`
  // One channel is enough: this is a slow brightness blotch, not a colour.
  float triMac = texture2D( map, triOctUv * uTriMacro + vec2( 0.63, 0.29 ) ).g;
  diffuseColor.rgb *= 1.0 + ( triMac - 0.5 ) * uTriMacroAmt;
`;

// ── Roughness ──────────────────────────────────────────────────────────────────
// Channel G, same as the stock chunk (ORM-compatible).

const HARD_ROUGH = /* glsl */`
float roughnessFactor = roughness;
#ifdef USE_ROUGHNESSMAP
  vec3 triPr = triPos();
  vec3 triNr = normalize( vTriNrm );
  roughnessFactor *= texture2D( roughnessMap, triUv( triPr, triNr, triAxis( triNr ) ) ).g;
#endif
`;

const BLEND_ROUGH = /* glsl */`
float roughnessFactor = roughness;
#ifdef USE_ROUGHNESSMAP
  vec3 triPr = triPos();
  vec3 triNr = normalize( vTriNrm );
  roughnessFactor *= triSample( roughnessMap, triPr, triNr, triWeights( triNr ) ).g;
#endif
`;

// ── Normals ────────────────────────────────────────────────────────────────────
// `normal` is in VIEW space at this point in the shader, so the world-space result
// gets rotated by the view matrix on the way out. The mesh's own tangents are
// deliberately unused: they describe the UV parameterisation we just threw away.

const HARD_NORMAL = /* glsl */`
#ifdef USE_NORMALMAP_TANGENTSPACE
  vec3 triPn = triPos();
  vec3 triNn = normalize( vTriNrm );
  int triAn = triAxis( triNn );
  vec3 triMapN = texture2D( normalMap, triUv( triPn, triNn, triAn ) ).xyz * 2.0 - 1.0;
  triMapN.xy *= normalScale;
  normal = normalize( ( viewMatrix * vec4( triWorldNormal( triMapN, triNn, triAn ), 0.0 ) ).xyz );
#endif
`;

// Whiteout blend (Ben Golus): fold the world normal into each plane's tangent-space
// sample before blending, so detail survives instead of averaging itself flat.
const BLEND_NORMAL = /* glsl */`
#ifdef USE_NORMALMAP_TANGENTSPACE
  vec3 triPn = triPos();
  vec3 triNn = normalize( vTriNrm );
  vec3 triWn = triWeights( triNn );

  vec3 nx = texture2D( normalMap, triUvX( triPn, triNn ) ).xyz * 2.0 - 1.0;
  vec3 ny = texture2D( normalMap, triUvY( triPn, triNn ) ).xyz * 2.0 - 1.0;
  vec3 nz = texture2D( normalMap, triUvZ( triPn, triNn ) ).xyz * 2.0 - 1.0;
  nx.xy *= normalScale;
  ny.xy *= normalScale;
  nz.xy *= normalScale;

  nx = vec3( nx.xy + triNn.zy, abs( nx.z ) * triNn.x );
  ny = vec3( ny.xy + triNn.xz, abs( ny.z ) * triNn.y );
  nz = vec3( nz.xy + triNn.xy, abs( nz.z ) * triNn.z );

  vec3 triWorldN = normalize( nx.zyx * triWn.x + ny.xzy * triWn.y + nz.xyz * triWn.z );
  normal = normalize( ( viewMatrix * vec4( triWorldN, 0.0 ) ).xyz );
#endif
`;
