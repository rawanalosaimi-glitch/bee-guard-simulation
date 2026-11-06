import { useEffect, useState } from 'react';
import * as THREE from 'three';
import { assetUrl } from '../pbr/library';
import { emblemDecal } from './beeEmblemLayout';

/**
 * Emblem decal on both flanks of a bee drone (presentation only).
 *
 * Artwork: the authentic national emblem, stored locally (no runtime download):
 *   public/assets/emblems/saudi_emblem.svg — Wikimedia Commons "Emblem of Saudi Arabia.svg"
 *   (public domain; byte-identical copy, SHA-256 in public/assets/emblems/SOURCE.txt)
 * No artwork is drawn or invented in code: if the file is missing the decal is simply not shown.
 *
 * The SVG is rasterised once (1024 px, transparent background, no rectangle) into a canvas texture
 * shared by all three bees, in the artwork's OWN colours (green palm, gold hilts, silver blades —
 * readable on the yellow body). The decal geometry carries the artwork's aspect ratio, so the image fills
 * the texture without distortion. EMBLEM_STYLE = 'gold' gives a single-colour gold version instead.
 *
 * Intel UHD: one shared 1024² texture with mipmaps (≈ 5.6 MB), one shared ~700-vertex mesh (both
 * sides) and one material → one extra draw call per bee. alphaTest (+ alpha-to-coverage when MSAA is
 * on) instead of blending, so there is no transparency sorting.
 */
export type EmblemStyle = 'gold' | 'original';
export const EMBLEM_STYLE: EmblemStyle = 'original';
const FILES = ['assets/emblems/saudi_emblem.svg', 'assets/emblems/saudi_emblem.png'];
const SIZE = 1024;

function loadImage(url: string): Promise<HTMLImageElement> {
  return new Promise((res, rej) => {
    const img = new Image();
    img.onload = () => res(img);
    img.onerror = () => rej(new Error(`emblem not found: ${url}`));
    img.src = url;
  });
}

/** Rasterise the artwork to fill the square texture (the decal geometry restores the true aspect). */
function rasterise(img: HTMLImageElement, style: EmblemStyle): HTMLCanvasElement {
  const pad = SIZE * 0.01;
  const art = document.createElement('canvas');
  art.width = art.height = SIZE;
  const a = art.getContext('2d')!;
  a.drawImage(img, pad, pad, SIZE - 2 * pad, SIZE - 2 * pad);
  if (style === 'original') return art;
  // single-colour gold version of the exact silhouette (inner cut-outs kept)
  const g = a.createLinearGradient(0, 0, 0, SIZE);
  g.addColorStop(0, '#ffe58a');
  g.addColorStop(0.5, '#f0c030');
  g.addColorStop(1, '#c8921a');
  a.globalCompositeOperation = 'source-in';
  a.fillStyle = g;
  a.fillRect(0, 0, SIZE, SIZE);
  return art;
}

let cache: Promise<THREE.Texture | null> | null = null;
function emblemTexture(): Promise<THREE.Texture | null> {
  if (cache) return cache;
  if (typeof document === 'undefined') return (cache = Promise.resolve(null));
  cache = (async () => {
    for (const f of FILES) {
      try {
        const img = await loadImage(assetUrl(f));
        const tex = new THREE.CanvasTexture(rasterise(img, EMBLEM_STYLE));
        tex.colorSpace = THREE.SRGBColorSpace;
        tex.anisotropy = 8;
        tex.generateMipmaps = true;
        tex.minFilter = THREE.LinearMipmapLinearFilter;
        return tex;
      } catch {
        /* try the next file */
      }
    }
    return null; // no authentic artwork supplied → no decal
  })();
  return cache;
}

let shared: { geo: THREE.BufferGeometry; mat: THREE.MeshStandardMaterial } | null = null;
function sharedMesh(tex: THREE.Texture) {
  if (shared) return shared;
  const d = emblemDecal();
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.Float32BufferAttribute(d.positions, 3));
  geo.setAttribute('uv', new THREE.Float32BufferAttribute(d.uvs, 2));
  geo.setIndex(d.indices);
  geo.computeVertexNormals();
  const mat = new THREE.MeshStandardMaterial({
    map: tex,
    alphaTest: 0.5,
    alphaToCoverage: true,
    // printed insignia: satin paint finish
    metalness: EMBLEM_STYLE === 'gold' ? 0.3 : 0.05,
    roughness: EMBLEM_STYLE === 'gold' ? 0.45 : 0.55,
    // a little self-illumination from the same texture keeps the emblem legible when the flank is in shade
    emissiveMap: tex,
    emissive: new THREE.Color('#ffffff'),
    emissiveIntensity: 0.1,
    polygonOffset: true,
    polygonOffsetFactor: -2,
    polygonOffsetUnits: -2,
  });
  shared = { geo, mat };
  return shared;
}

/** Both-side emblem decal, a child of the bee model: it moves, yaws and tilts with the drone. */
export function BeeEmblem() {
  const [tex, setTex] = useState<THREE.Texture | null>(null);
  useEffect(() => {
    let live = true;
    emblemTexture().then((t) => live && setTex(t));
    return () => {
      live = false;
    };
  }, []);
  if (!tex) return null;
  const { geo, mat } = sharedMesh(tex);
  return <mesh geometry={geo} material={mat} renderOrder={1} />;
}
