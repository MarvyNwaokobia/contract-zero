import * as THREE from 'three';

/**
 * Image-based lighting for the compound, generated from the zone's own sky.
 *
 * WHY THIS EXISTS AT ALL
 * ----------------------
 * Every metal surface in the game was authored expecting one. GunMesh.ts sets
 * `envMapIntensity: 1.8` on the weapon body and its own comment says "+ an
 * environment map (set via scene.environment) that these surfaces reflect";
 * ItemMesh.ts does the same for marketplace items. Nothing ever set it, so every
 * one of those values multiplied a black environment and did nothing. A material
 * at `metalness: 0.95, roughness: 0.3` with no environment to reflect is not
 * steel, it is flat dark grey — and that material is the VIEWMODEL, the single
 * most on-screen object in a first-person shooter.
 *
 * WHY IT IS GENERATED RATHER THAN LOADED
 * --------------------------------------
 * The obvious move is an HDRI, and there is one in the repo (venice_sunset_1k).
 * It is wrong twice over: 1.4MB of download on a project already fighting load
 * time, and it is a sunny Italian canal, so it would light Ashfall at noon and
 * the Rift at midnight identically.
 *
 * The sky is already described per zone: ZONE_THEMES carries `sky.top`/`sky.bottom`
 * for the gradient dome the player actually sees, plus the sun's colour and
 * intensity and a hemisphere ground colour. Rendering THAT into a small cubemap
 * costs no download, and every zone automatically reflects the light of the place
 * it is set in — Ashfall's blue day, the Proving Ground's low orange sun, the
 * Rift's deep blue night.
 *
 * COST
 * ----
 * One prefilter pass per zone load, then free: an environment map is a texture
 * lookup already compiled into MeshStandardMaterial's shader. Unlike the four
 * point lights the perf work removed, it does not scale with pixel count or
 * object count, so it is safe to leave on at EVERY quality tier including
 * `minimal`. This is the rare visual upgrade that does not push anyone further
 * down the degrade path.
 */

/**
 * Where the sun sits. Must stay in step with the key light in ValorScene
 * (`<directionalLight position={[9, 16, 10]}>`), or the specular hotspot on the
 * weapon will disagree with the direction its shadows fall.
 */
export const SUN_DIR = new THREE.Vector3(9, 16, 10).normalize();

/**
 * Global multiplier on the environment, on top of each material's own
 * `envMapIntensity`.
 *
 * Full strength, deliberately. An earlier pass ran this at 0.35 as a safety
 * margin against washing out the hand-tuned zone lighting, but that divides the
 * weapon's authored 1.8 down to 0.63 — BELOW neutral — so the one surface the
 * whole feature exists for ended up with less environment than a default material
 * would get. The result was visible in an A/B and still too weak to matter.
 *
 * The correct place to hold the compound back is the compound itself: the
 * triplanar factory damps every wall, floor and prop to envMapIntensity 0.25 (see
 * triplanar.ts). That way metal and matte respond differently to the same sky,
 * which is what an environment map is for. Damping globally made everything
 * respond equally and weakly.
 */
export const ENV_INTENSITY = 1;

export interface ZoneEnvParams {
  /** Zenith colour of the sky dome. */
  skyTop: string;
  /** Horizon colour of the sky dome. */
  skyBottom: string;
  sunColor: string;
  sunIntensity: number;
  /** Hemisphere light's ground colour — what bounces up from below. */
  groundColor: string;
  /** Floor tint, blended into the ground so reflections match the actual floor. */
  floorTint: string;
}

const VERTEX = `
varying vec3 vDir;
void main() {
  vDir = position;
  gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
}
`;

/**
 * Sky above the horizon, ground below it, sun disc on top.
 *
 * The dome the player sees (SkyDome in ValorScene) fades to its horizon colour
 * below the horizon, because nothing is ever drawn down there — the compound
 * floor covers it. An environment map has no such luxury: the lower hemisphere is
 * exactly what a gun barrel held at chest height reflects, so leaving it sky-
 * coloured makes metal look lit from underneath by a second sky. Hence the third
 * band.
 */
const FRAGMENT = `
varying vec3 vDir;
uniform vec3 uTop;
uniform vec3 uHorizon;
uniform vec3 uGround;
uniform vec3 uSunColor;
uniform vec3 uSunDir;
uniform float uSunGain;

void main() {
  vec3 d = normalize(vDir);
  float h = d.y;

  vec3 col = h > 0.0
    ? mix(uHorizon, uTop,    pow(h,  0.55))
    : mix(uHorizon, uGround, pow(-h, 0.45));

  // A tight disc for the specular hotspot, plus a broad halo so the sky nearest
  // the sun is warmer than the sky opposite it. Without the halo the prefiltered
  // rough mips lose the sun almost entirely and the whole point is gone.
  float c = dot(d, uSunDir);
  float disc = smoothstep(0.9970, 0.9993, c);
  float halo = pow(max(c, 0.0), 48.0);
  col += uSunColor * uSunGain * (disc * 6.0 + halo * 0.55);

  gl_FragColor = vec4(col, 1.0);
}
`;

/**
 * Build a prefiltered environment map for one zone.
 *
 * Returns the render target rather than the bare texture: the caller has to keep
 * it to dispose it, and disposing the texture alone leaks the target's buffers.
 * Assign `.texture` to `scene.environment`, call `.dispose()` on teardown.
 */
export function buildZoneEnvironment(
  renderer: THREE.WebGLRenderer,
  p: ZoneEnvParams,
): THREE.WebGLRenderTarget {
  const scene = new THREE.Scene();

  // Ground is the hemisphere's bounce colour pulled halfway to the actual floor
  // tint, so what the weapon reflects from below is roughly the floor it is over.
  const ground = new THREE.Color(p.groundColor).lerp(new THREE.Color(p.floorTint), 0.5);

  const geometry = new THREE.SphereGeometry(10, 32, 24);
  const material = new THREE.ShaderMaterial({
    side: THREE.BackSide,
    depthWrite: false,
    vertexShader: VERTEX,
    fragmentShader: FRAGMENT,
    uniforms: {
      uTop:      { value: new THREE.Color(p.skyTop) },
      uHorizon:  { value: new THREE.Color(p.skyBottom) },
      uGround:   { value: ground },
      uSunColor: { value: new THREE.Color(p.sunColor) },
      uSunDir:   { value: SUN_DIR.clone() },
      uSunGain:  { value: p.sunIntensity },
    },
  });

  const dome = new THREE.Mesh(geometry, material);
  scene.add(dome);

  const pmrem = new THREE.PMREMGenerator(renderer);
  // near/far must bracket the dome's radius (10) or it is clipped away and the
  // prefilter returns black.
  const target = pmrem.fromScene(scene, 0, 0.1, 100);

  geometry.dispose();
  material.dispose();
  pmrem.dispose();

  return target;
}
