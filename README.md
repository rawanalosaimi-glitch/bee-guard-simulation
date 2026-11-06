# BEE-GUARD | Digital Twin Simulation (v0.8.0-rc1)

> **Important:** BEE-GUARD is a **scientific research simulation**. It is **not a validated or approved field system**. All sensor readings, radiation values, casualty data and mission results shown in this application are **simulated**.

Interactive 3D digital-twin simulation of a mother UAV and three micro-UAVs (BEE-01/02/03) for radiological emergency response: radiation survey and mapping, casualty assessment, corridor validation and evacuation planning.

## Run locally

Requires Node.js 20.19 or newer.

```bash
npm ci
npm run dev        # development server at http://localhost:5173
npm run build      # production build into dist/
npm run preview    # serve the production build at http://localhost:4173
npm run typecheck
```

## Deployment (Vercel)

Static Vite site, configured in `vercel.json`:

| Setting | Value |
|---|---|
| Framework | Vite |
| Install command | `npm ci` |
| Build command | `npm run build` |
| Output directory | `dist` |

There is no backend, and no environment variables are required.

## Repository contents

- `src/`: application and simulation engine (deterministic, seeded).
- `public/assets/`: CC0 textures (Poly Haven) with their licences, and an emblem with its source note.
- `tests/` and `experiments/reference_results_*/runs_summary.csv`: tests and reference results for reproducibility checks. These are not part of the deployed website (see `.vercelignore`).

This repository is a deployment copy of the BEE-GUARD v0.8.0-rc1 release. The simulation logic, scenarios, seeds, radiation calculations and results are unchanged. The only differences are visual and metadata changes:

- the browser tab title and meta description;
- the landing-pad surface under the mother UAV is not drawn.
