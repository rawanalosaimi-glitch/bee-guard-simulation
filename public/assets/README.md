# BEE-GUARD local 3D assets (Stage 4)

Everything in this folder is served **locally** by Vite. Nothing is fetched from the internet at runtime. Every slot is optional: a slot with no files uses a deterministic procedural fallback (`src/viz/pbr/library.ts`).

## Folder layout

```
public/assets/
  manifest.json                 generated — do not edit by hand (npm run assets:scan)
  textures/<slot>/              one CC0 PBR set per slot (albedo + normal + roughness, AO optional)
  textures/<slot>/tile.json     optional: {"tile_m": 2.0, "mean_rgb": [136,107,82]} or {"same_as": "sand"}
  models/<slot>.glb             optional CC0 GLB model
  hdri/<name>.hdr               optional equirectangular HDRI (ambient light only; the visible sky stays procedural)
```

## Texture slots

| Slot | Default tile | Used for | Suggested CC0 search |
|---|---|---|---|
| `sand` | 9 m | desert terrain | aerial sand, desert sand, dry ground |
| `ground` | 3 m | fine relief / roughness over the painted site map | dry soil, gravel |
| `asphalt` | 3 m | roads | cracked asphalt |
| `concrete` | 2.5 m | control building, stack, barriers, rubble | weathered concrete |
| `corrugated_metal` | 2 m | warehouse, roofs, shipping containers | corrugated metal |
| `painted_steel` | 3 m | storage tanks, vehicles, pipes | painted metal, metal plates |
| `rust` | 2 m | damaged containers, debris, burnt car | rust, rusty metal |

**File names.** Map types are recognised from the file names:
- Poly Haven: `*_diff_*`, `*_nor_gl_*`, `*_rough_*`, `*_ao_*`
- ambientCG: `*_Color`, `*_NormalGL` / `*_NormalDX`, `*_Roughness`, `*_AmbientOcclusion`
- Plain names: `albedo`, `normal`, `roughness`

GL normals are preferred; DX normals are flipped automatically.

**`tile.json` fields.**
- `tile_m`: the real-world size of one tile, in metres.
- `mean_rgb`: the mean sRGB albedo, which enables the albedo calibration and colour-cast neutralisation in `src/viz/pbr/calibrate.ts`.
- `same_as`: re-uses another slot's files, with no duplicate download.

**Size and resolution.** Use 1K or 2K JPG for Intel UHD. 4K is wasted at these viewing distances, and EXR / `.blend` are never loaded by the app. A folder may hold one set per resolution, marked by the file names (`_1k`, `_2k`). Performance and Balanced load 1K; High loads 2K.

**Shipped sets.** The three supplied Poly Haven CC0 sets are already converted:
- `sand` (and `ground`): `rocky_trail_02`, 2.0 m tile;
- `concrete`: `concrete_layers`, 1.55 m tile;
- `corrugated_metal`: `corrugated_iron`, 1.12 m tile.

How they were converted from the 4K packages: `tools/cc0-convert/README.md`.

**Scale.** Geometry carries world-scale UVs, so one tile always covers `tile_m` metres on every object.

## Model slots (`models/<slot>.glb`)

| Slot | Fitted to |
|---|---|
| `container` | decorative container-yard boxes, 6.06 m (the breached container that is a simulation obstacle stays procedural) |
| `tank` | reserved — the tanks are fitted to simulation obstacles and stay procedural |
| `barrier` | concrete jersey barrier, ≈ 3 m long |
| `fire_truck` | fire engine, ≈ 8.5 m long |
| `ambulance` | ambulance, ≈ 6 m long |
| `hazmat_van` | CBRN / hazmat van, ≈ 6 m long |
| `tent` | decontamination tent, ≈ 6 m long |
| `debris` | rubble pile, ≈ 3 m (reserved) |

Each model is scaled uniformly so its longest horizontal side matches the slot length, then stood on the ground at the procedural prop's position. Models must not carry real organisations' logos or protected emblems (for example the red cross or red crescent).

## After adding or removing files

```
npm run assets:scan        # rewrites manifest.json and prints which slots are filled
npm run check:offline      # confirms no absolute http(s) URL in src/ and that the manifest is local
```

Then reload the page. Use only CC0 or equivalently licensed files, and keep each source's licence note next to it (for example `textures/sand/LICENSE.txt`).
