import type * as THREE from 'three';

/**
 * Stage 4 — cheap texture anti-tiling for photographed CC0 albedo maps at real-world scale.
 *
 * At physical tile sizes (1.1–2 m) a large wall or the terrain shows each tile's dirt/rock layout
 * as a regular grid. Following the "technique 3" of I. Quilez (texture repetition), the albedo is
 * sampled twice with two pseudo-random UV offsets chosen per large region by an arithmetic value
 * noise, and the two samples are blended across region borders. Cost: one extra albedo fetch and a
 * few ALU ops per pixel (no extra textures) — normal / roughness maps stay single-sampled.
 *
 * The extra work is compiled in only while the BG_ANTITILE define is set (`setAntiTiling`): it is off in
 * the Performance profile, where it measured ≈ 2× the frame time on a software rasteriser (SwiftShader).
 *
 * `axis: 'v'` offsets only along v (for directional textures such as corrugated sheet whose ridges
 * run along v), so ridges stay continuous.
 */
export function applyAntiTiling(mat: THREE.MeshStandardMaterial, axis: 'uv' | 'v' = 'uv', scale = 0.12): void {
  const prev = mat.onBeforeCompile;
  mat.onBeforeCompile = (shader: THREE.WebGLProgramParametersWithUniforms, renderer: THREE.WebGLRenderer) => {
    prev?.call(mat, shader, renderer);
    shader.fragmentShader = shader.fragmentShader
      .replace(
        '#include <common>',
        `#include <common>
float bgHash(vec2 p) { return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }
float bgNoise(vec2 p) {
  vec2 i = floor(p); vec2 f = fract(p); f = f * f * (3.0 - 2.0 * f);
  return mix(mix(bgHash(i), bgHash(i + vec2(1.0, 0.0)), f.x), mix(bgHash(i + vec2(0.0, 1.0)), bgHash(i + vec2(1.0, 1.0)), f.x), f.y);
}
vec4 bgAntiTile(sampler2D tex, vec2 uv) {
  float k = bgNoise(uv * ${scale.toFixed(4)}) * 8.0;
  float i = floor(k); float f = fract(k);
  vec2 offA = sin(vec2(3.0, 7.0) * (i + 0.0));
  vec2 offB = sin(vec2(3.0, 7.0) * (i + 1.0));
  ${axis === 'v' ? 'offA.x = 0.0; offB.x = 0.0;' : ''}
  vec2 dx = dFdx(uv); vec2 dy = dFdy(uv);
  vec4 a = textureGrad(tex, uv + offA, dx, dy);
  vec4 b = textureGrad(tex, uv + offB, dx, dy);
  vec3 d = a.rgb - b.rgb;
  return mix(a, b, smoothstep(0.2, 0.8, f - 0.1 * (d.x + d.y + d.z)));
}`,
      )
      .replace(
        '#include <map_fragment>',
        `#ifdef USE_MAP
  #ifdef BG_ANTITILE
    vec4 sampledDiffuseColor = bgAntiTile(map, vMapUv);
  #else
    vec4 sampledDiffuseColor = texture2D(map, vMapUv);
  #endif
  #ifdef DECODE_VIDEO_TEXTURE
    sampledDiffuseColor = vec4(mix(pow(sampledDiffuseColor.rgb * 0.9478672986 + vec3(0.0521327014), vec3(2.4)), sampledDiffuseColor.rgb * 0.0773993808, vec3(lessThanEqual(sampledDiffuseColor.rgb, vec3(0.04045)))), sampledDiffuseColor.w);
  #endif
  diffuseColor *= sampledDiffuseColor;
#endif`,
      );
  };
  const prevKey = mat.customProgramCacheKey?.bind(mat);
  mat.customProgramCacheKey = () => `${prevKey ? prevKey() : ''}|antitile:${axis}:${scale}`;
  setAntiTiling(mat, true);
}

/** Switch the anti-tiling on or off on a material prepared by applyAntiTiling (recompiles once). */
export function setAntiTiling(mat: THREE.MeshStandardMaterial, on: boolean): void {
  const d = (mat.defines ??= {}) as Record<string, unknown>;
  if (on === 'BG_ANTITILE' in d) return;
  if (on) d.BG_ANTITILE = '';
  else delete d.BG_ANTITILE;
  mat.needsUpdate = true;
}
