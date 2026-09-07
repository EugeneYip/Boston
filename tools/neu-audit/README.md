# neu-audit — factual audit for the Northeastern hero district

Measures the real Northeastern University district against what BOSTON currently
builds there, and writes the evidence package under `docs/neu/`.

```bash
node tools/neu-audit/fetch.mjs      # network -> tools/neu-audit/.cache (not committed)
node tools/neu-audit/build.mjs      # cache + src/data -> docs/neu/*.json
```

`fetch.mjs --force` re-fetches instead of using the cache.

## Why it works the way it does

**Everything is measured in BOSTON world metres**, by pushing real lat/lon through
the game's own `geo()` rather than through a second projection. Measuring the world
the way the game builds it is the whole point; a private projection could disagree
with the engine and the disagreement would look like a geography defect.

**The cache is not committed.** OpenStreetMap extracts are ODbL, so a checked-in
copy is a redistributed database with share-alike attached. The committed artefacts
are derived factual tables with attribution. See `docs/neu/SOURCES.md`.

**Nothing here is imported by `src/`,** and `build.mjs` writes only into `docs/`.
This is evidence preparation, not a content pipeline.

## Gotchas worth keeping

- Overpass answers **406** to a request with no `User-Agent`, whatever the query
  says. It also rate-limits with **429**; `fetch.mjs` falls back to a mirror.
- Anchor features are selected **by OSM id, with tags kept in the output**. An
  earlier pass picked them by wikidata id guessed from memory and got Melbourne
  and the Huntington Library in California. Do not guess identifiers.
- Street deviation is sampled only **well inside** the fetched extract. Sampling to
  the edge measures the extract boundary, not the road: Tremont Street first
  scored a 2,268 m "error" that way, purely because the game's polyline continues
  far beyond the bbox.
- Centroids are **area-weighted**, not vertex means. Both OSM and the university's
  footprints carry more vertices along a detailed street frontage than across a
  plain back wall, which drags a vertex mean toward the street.
