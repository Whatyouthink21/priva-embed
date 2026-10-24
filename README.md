# Priva Embed

API embed player for movies & TV shows. Drop an iframe into your streaming site and stream instantly.

## Providers (codename only in the player)

| Codename | Real provider |
|----------|---------------|
| Clarke   | castle        |
| Raven    | movieBoxWeb   |
| Bellamy  | autoEmbed     |

The real provider names are **never shown** in the player — only codenames appear.

## Endpoints

**Movie:** `GET /player/{tmdb_id}`
**TV Show:** `GET /player/{tmdb_id}/{season}/{episode}`

Example iframe:

```html
<iframe
  src="https://priva-embed.onrender.com/player/550"
  width="100%"
  height="100%"
  frameborder="0"
  allowfullscreen
  allow="encrypted-media"
></iframe>
```

Responsive 16:9:

```html
<div style="position:relative;padding-bottom:56.25%;height:0;">
  <iframe
    src="https://priva-embed.onrender.com/player/550"
    style="position:absolute;top:0;left:0;width:100%;height:100%;"
    frameborder="0"
    allowfullscreen
    allow="encrypted-media"
  ></iframe>
</div>
```

## API

- `GET /api/meta?tmdb_id={id}&type=movie|series` — title, poster, synopsis, year
- `GET /api/streams?tmdb_id={id}&type=movie|series&season={n}&episode={n}` — streams from Clarke/Raven/Bellamy
- `GET /api/health` — service health

## Deployment on Render

1. Push this repo to GitHub.
2. Create a new **Web Service** on Render connected to the repo.
3. Build command: `npm install`
4. Start command: `npm start`
5. Node version >= 20 (set in `engines`).

Or use `render.yaml` (included) via Render's "Infrastructure as Code".

## Notes

- Extraction logic is vendored from https://github.com/Zenda-Cross/vega-providers (castle, movieBoxWeb, autoEmbed) under `providers/vega/`.
- Works best when the host can reach the provider backends; in restricted sandboxes the UI/meta shell still loads while external provider calls fail gracefully.
