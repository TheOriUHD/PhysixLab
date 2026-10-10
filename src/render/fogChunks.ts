/**
 * Height fog (VZ-13): three.js has linear and exponential fog; this patches the shared fog shader chunks so that a
 * linear `Fog` whose `far` is negative becomes exponential *height* fog — `near` carries the density at world
 * height 0 and `-far` the falloff per metre — integrated analytically along the view ray. Plain fogs are unchanged.
 * Install once, before any material is compiled.
 */
import { ShaderChunk } from 'three';

let installed = false;

export function installHeightFog(): void {
  if (installed) return;
  installed = true;
  ShaderChunk.fog_pars_vertex = /* glsl */ `
#ifdef USE_FOG
	varying float vFogDepth;
	varying float vFogWorldY;
#endif`;
  ShaderChunk.fog_vertex = /* glsl */ `
#ifdef USE_FOG
	vFogDepth = - mvPosition.z;
	vFogWorldY = cameraPosition.y + dot( viewMatrix[ 1 ].xyz, mvPosition.xyz );
#endif`;
  ShaderChunk.fog_pars_fragment = /* glsl */ `
#ifdef USE_FOG
	uniform vec3 fogColor;
	varying float vFogDepth;
	varying float vFogWorldY;
	#ifdef FOG_EXP2
		uniform float fogDensity;
	#else
		uniform float fogNear;
		uniform float fogFar;
	#endif
#endif`;
  ShaderChunk.fog_fragment = /* glsl */ `
#ifdef USE_FOG
	#ifdef FOG_EXP2
		float fogFactor = 1.0 - exp( - fogDensity * fogDensity * vFogDepth * vFogDepth );
	#else
		float fogFactor;
		if ( fogFar < 0.0 ) {
			float k = - fogFar;
			float dy = vFogWorldY - cameraPosition.y;
			float e0 = exp( - k * cameraPosition.y );
			float e1 = exp( - k * vFogWorldY );
			float avg = abs( k * dy ) < 1e-4 ? e0 : ( e0 - e1 ) / ( k * dy );
			fogFactor = 1.0 - exp( - fogNear * vFogDepth * avg );
		} else {
			fogFactor = smoothstep( fogNear, fogFar, vFogDepth );
		}
	#endif
	gl_FragColor.rgb = mix( gl_FragColor.rgb, fogColor, clamp( fogFactor, 0.0, 1.0 ) );
#endif`;
}

/** The `Fog` parameters that make height fog of density `d` at height `h0` with falloff `k` (see above). */
export function heightFogParams(density: number, h0: number, k: number): { near: number; far: number } {
  const e = Math.min(30, k * h0);
  return { near: density * Math.exp(e), far: -Math.max(k, 1e-4) };
}
