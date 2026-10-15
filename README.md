# Lakshmi-Nandan Studio

Lakshmi-Nandan Studio is a browser-based, layer-oriented image editor. The editor runs in the browser; project files and autosaves stay on the device. Optional text-to-image generation is provided by a same-origin Cloudflare Worker using Workers AI.

## Run the editor locally

The static editor works without a build step. From this directory, run:

```powershell
python -m http.server 8000
```

Then open `http://localhost:8000`. Opening `index.html` directly also loads the local editor, but browser storage and file APIs work more consistently over localhost.

## Enable AI generation

1. Install Node.js, then run `npx wrangler login` from this directory.
2. Enable Workers AI for your Cloudflare account and confirm the Workers AI binding is available.
3. Start locally with `npx wrangler dev`.
4. Deploy with `npx wrangler deploy`, then open the deployed Worker URL.

`wrangler.toml` binds Workers AI as `env.AI`, configures a per-IP request limit, and serves the app assets from this directory. The Worker exposes only the status and image-generation endpoints, validates same-origin requests and prompt length, and does not accept arbitrary model names or forward provider credentials to the browser. The limit is five generation requests per minute per Cloudflare location; Cloudflare's rate-limit counters are intentionally approximate across locations.

Image generation uses Cloudflare's `@cf/black-forest-labs/flux-1-schnell` model. Workers AI availability and included usage depend on the current Cloudflare account plan and quotas; a free allowance is not unlimited or guaranteed. The editor reports provider errors instead of showing fabricated results. The current AI feature generates a new image layer; background removal, inpainting, and super-resolution are not implemented.

## Editor features

- Raster/image layers, editable text and shape layers, layer masks, blend modes, and opacity
- Brush/eraser, selection tools, magic wand, canvas pan/zoom, and keyboard shortcuts
- Adjustment layers, raster filters, undo/redo, PNG/JPEG export
- `.aether` project import/export and browser IndexedDB autosave recovery
- Responsive desktop, tablet, and mobile layouts
