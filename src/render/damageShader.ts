/**
 * VZ-41: the damage look, patched into MeshStandardMaterial. `vDmg` (0..1) comes from a per-mesh uniform or, for
 * instanced bodies, from the per-instance `aDamage` attribute. Cracks are the edges of a 3-D cellular pattern in the
 * body's local space (so they stay on the object), scorch is darkening noise around the worst spots, and each material
 * kind adds its own flavour: metal gets dent-tint (darker, rougher), glass gets bright crack lines, wood a pale
 * splintered tint.
 */
import type { MeshStandardMaterial, WebGLProgramParametersWithUniforms } from 'three';
import { DAMAGE_KIND_INDEX, type DamageKind } from './damage';

export interface DamageHandle {
  uniforms: { uDamage: { value: number }; uKind: { value: number } };
}

const GLSL = /* glsl */ `
vec3 dmgHash3(vec3 p) {
  p = vec3(dot(p, vec3(127.1, 311.7, 74.7)), dot(p, vec3(269.5, 183.3, 246.1)), dot(p, vec3(113.5, 271.9, 124.6)));
  return fract(sin(p) * 43758.5453);
}
// returns (edge distance F2-F1, F1)
vec2 dmgVoronoi(vec3 x) {
  vec3 n = floor(x); vec3 f = fract(x);
  float f1 = 8.0, f2 = 8.0;
  for (int k = -1; k <= 1; k++) for (int j = -1; j <= 1; j++) for (int i = -1; i <= 1; i++) {
    vec3 g = vec3(float(i), float(j), float(k));
    vec3 o = dmgHash3(n + g);
    float d = length(g + o - f);
    if (d < f1) { f2 = f1; f1 = d; } else if (d < f2) { f2 = d; }
  }
  return vec2(f2 - f1, f1);
}
float dmgNoise(vec3 p) { return dmgHash3(floor(p)).x * 0.5 + dmgHash3(floor(p * 2.0 + 7.0)).y * 0.5; }
`;

/** Add the damage look to a material (idempotent). Returns the handle whose uniforms the caller drives. */
export function patchDamage(mat: MeshStandardMaterial, kind: DamageKind, instanced: boolean): DamageHandle {
  const existing = (mat.userData as { damage?: DamageHandle }).damage;
  if (existing) {
    existing.uniforms.uKind.value = DAMAGE_KIND_INDEX[kind];
    return existing;
  }
  const handle: DamageHandle = {
    uniforms: { uDamage: { value: 0 }, uKind: { value: DAMAGE_KIND_INDEX[kind] } },
  };
  (mat.userData as { damage?: DamageHandle }).damage = handle;
  const hook = (shader: WebGLProgramParametersWithUniforms): void => {
    shader.uniforms.uDamage = handle.uniforms.uDamage;
    shader.uniforms.uKind = handle.uniforms.uKind;
    shader.vertexShader = shader.vertexShader
      .replace(
        '#include <common>',
        `#include <common>
varying vec3 vDmgPos;
varying float vDmg;
uniform float uDamage;
${instanced ? 'attribute float aDamage;' : ''}`,
      )
      .replace(
        '#include <begin_vertex>',
        `#include <begin_vertex>
vDmgPos = position;
vDmg = ${instanced ? 'aDamage' : 'uDamage'};`,
      );
    shader.fragmentShader = shader.fragmentShader
      .replace(
        '#include <common>',
        `#include <common>
varying vec3 vDmgPos;
varying float vDmg;
uniform float uKind;
${GLSL}`,
      )
      .replace(
        '#include <color_fragment>',
        `#include <color_fragment>
float dmgCrack = 0.0;
if (vDmg > 0.02) {
  vec3 q = vDmgPos * 5.0;
  vec2 v = dmgVoronoi(q);
  float width = mix(0.02, 0.09, vDmg);
  // cracks open up as damage grows: a cell edge counts once the damage passes the cell's own threshold
  float cellT = dmgHash3(floor(q)).z;
  dmgCrack = (1.0 - smoothstep(0.0, width, v.x)) * step(cellT, vDmg * 1.15);
  float scorch = smoothstep(0.35, 1.0, vDmg) * dmgNoise(vDmgPos * 6.0) * 0.55;
  if (uKind > 2.5) {            // wood: pale splinters along the cracks, dark scuffs
    diffuseColor.rgb = mix(diffuseColor.rgb, vec3(0.78, 0.62, 0.4), dmgCrack * 0.75);
    diffuseColor.rgb *= 1.0 - scorch * 0.6;
  } else if (uKind > 1.5) {     // glass: bright crack lines, more opaque where cracked
    diffuseColor.rgb = mix(diffuseColor.rgb, vec3(0.92, 0.97, 1.0), dmgCrack * 0.9);
    diffuseColor.a = clamp(diffuseColor.a + dmgCrack * 0.6 + vDmg * 0.15, 0.0, 1.0);
  } else if (uKind > 0.5) {     // metal: dent-tint
    diffuseColor.rgb *= 1.0 - (0.18 * vDmg + scorch * 0.7);
    diffuseColor.rgb = mix(diffuseColor.rgb, vec3(0.08), dmgCrack * 0.5);
  } else {                      // generic: dark cracks and scorch
    diffuseColor.rgb = mix(diffuseColor.rgb * (1.0 - scorch), vec3(0.04), dmgCrack * 0.85);
  }
}`,
      )
      .replace(
        '#include <roughnessmap_fragment>',
        `#include <roughnessmap_fragment>
roughnessFactor = clamp(roughnessFactor + vDmg * 0.35 + dmgCrack * 0.2, 0.0, 1.0);`,
      );
  };
  const key = instanced ? 'dmg-i' : 'dmg';
  // The shape-surface module composes this hook with its own (a body can be both damaged and painted).
  (mat.userData as { damageHook?: unknown; damageKey?: string }).damageHook = hook;
  (mat.userData as { damageKey?: string }).damageKey = key;
  mat.onBeforeCompile = hook;
  mat.customProgramCacheKey = () => key;
  mat.needsUpdate = true;
  return handle;
}
