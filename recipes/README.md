# Authoring a brewing recipe

1. Copy an existing `.cook` file into this directory.
2. Give it a unique, stable `coffee.id`; change the metadata and instructions.
3. Run `npm run check:recipes` (no database required).
4. Restart the service and reload the browser. Docker images must be rebuilt.

Every top-level `.cook` file is discovered at startup. There is no manifest,
generated file, or per-recipe JavaScript. Invalid files stop startup with their
filename and diagnostic instead of silently disappearing from the menu.

## Example

This is a timed steep-and-press example, not a manufacturer recommendation:

```cooklang
---
title: AeroPress Steep
coffee:
  id: aeropress-steep
  brewer: aeropress
  brewerName: AeroPress
  label: Steep & Press
  size: Original
  min: 12
  max: 20
  dose: 15
  grind: Medium-fine
  texture: Adjust to taste.
  temperature: 195–205°F
  order: 40
---

= Prep =
Rinse the filter and discard the rinse water. Put @coffee{15%g} in the #AeroPress{} over a sturdy cup.

= Fill =
Add @water{225%g} over ~scaled{20%seconds}.

= Steep =
Stir gently and steep for ~{90%seconds}.

= Press =
Press gently for ~{30%seconds}.

= Finish =
Remove the brewer and enjoy.
```

The same example is exercised by the API/browser tests in
[`tests/fixtures/recipes/aeropress-steep.cook`](../tests/fixtures/recipes/aeropress-steep.cook).
It is not included in the production menu unless copied here.

## Metadata

All fields shown above are required except `order` (default 100).
`id` and `brewer` are lowercase slugs; keep IDs stable after recording brews.
Recipes sharing a brewer must use the same `brewerName`. Each recipe's
`label` appears in its brewer's recipe selector and journal.

- `min`, `max`, `dose`: grams, 0.1 g increments, within 0.1–100 g.
- `grind`, `texture`: starting advice, overridable per recipe in the browser.
- `temperature`: descriptive recommended range; the user's entered °F remains
  independent and is not automatically changed when switching recipes.
- `order`: ascending menu order, then ID. The first recipe is the default.
- Optional `icon` and `description`: brewer button presentation; the first
  recipe for that brewer supplies these.
- `legacyVariant`: reserved for compatibility with the three original recipes.
  Do not copy it into a new recipe.

Unknown `coffee` fields are rejected to catch typos. Standard Cooklang metadata
such as `title`, `source`, and `author` may also be included.

## Instructions and ingredients

Use **one paragraph per named section**. Line wrapping within that paragraph is
fine. The first section must be `Prep`, the last `Finish`; they are untimed.
Each intervening section is one timer step, with its section name as the title.

- Prep must contain exactly one `@coffee{15%g}` matching the default dose.
- Brewing ice goes in one Prep quantity, e.g. `@ice{75%g}`. It contributes to the combined
  ratio, but never to poured-water targets.
- A pour step contains one `@water{60%g}`. This means **add 60 g**, not pour
  to a cumulative target of 60 g.
- A rest, steep, or press step contains no water ingredient.
- Finish contains plain instructions and optional cookware, not ingredients.
- Describe rinse water and optional topping ice in ordinary text so they are
  excluded from brew totals.
- Equipment uses ordinary Cooklang syntax, e.g. `#V60{}`.
- Ingredients are restricted to `coffee`, `water`, and `ice`, in `g`.
  Fractions such as `@water{86 2/3%g}` are supported.

Ingredient quantities scale with the chosen dose. Use Cooklang's scaling lock,
e.g. `@water{=60%g}`, for a fixed quantity; coffee itself must scale.
Cumulative water totals round to whole grams, then each step's actual addition
and flow rate are derived from those totals. Rendered pour instructions use the
same rounded additions as the scale targets. Brewing ice also rounds to grams.
The displayed ratio uses the unrounded quantities.

This cumulative-rounding rule can move intermediate targets by 1 g at some
non-default doses compared with the old engine, which rounded the bloom and
total before splitting the remaining water. Default targets, final water/ice,
and timing of the three original recipes are unchanged.

## Timers

Every timed section must contain **exactly one** Cooklang timer:

| Syntax | Meaning |
| --- | --- |
| `~{20%seconds}` or `~fixed{20%seconds}` | Fixed 20-second step |
| `~scaled{20%seconds}` | 20 seconds at the default dose; scales with dose, rounds to seconds |
| `~until{45%seconds}` | End this step at 0:45 on the running brew clock |

`minutes` is also supported, including fractions that resolve to whole seconds.
An `until` timer uses the brew's elapsed clock, not wall time, and therefore
respects pauses. Write its surrounding text accordingly: “Wait until … on the
brew clock.” Other timer names and units are rejected.

Validation evaluates **every supported dose**, checking that every step lasts
at least one second, pours add at least one gram, and the timeline stays within
24 hours. This catches scaled pours that would overrun an `until` mark.

Instructions can describe pressing, stirring, or other actions, but the engine
only advances by elapsed time. Manual confirmation steps, arbitrary formulas,
parallel timers, optional/hidden ingredients, ingredient references/aliases/notes, and general-purpose cooking
recipes are not supported. Unsupported structures are rejected rather than
partially executed. Comments use standard Cooklang `-- comment` syntax.

## Persistence and editing

Dose/grinder preferences are keyed by recipe ID. Old browser preferences and
brewer/variant requests migrate automatically; no database migration is needed.
Active local timers store their recipe definition, so editing a file cannot
change an already-running timeline after reload. Journal entries retain the
server-generated recipe snapshot.

“Brew again” selects the **current** file with that ID using the recorded dose,
grinder, and temperature. Removed recipes cannot be repeated; their journal
entries remain readable. A dose outside a revised range must be adjusted.

Sync pending brews before changing/removing their files. New starts carry a
content hash; stale starts remain queued with an error, rather than saving a
different recipe. Restore the prior file revision and restart to sync them.
Already-saved starts remain idempotent even after a file is edited or removed.

## Implementation

The official Cooklang parser runs only on the server. The browser fetches
validated JSON definitions from `GET /api/recipes` and shares the pure timeline
compiler in `public/recipe.js` with the API. No frontend bundler or WASM download
is required.

The parser is pinned to 0.18.7 because the 0.19.0 npm package omitted its WASM
files. A small Node adapter instantiates the bundled WASM explicitly to support
Node 22+ without experimental module-import flags.
