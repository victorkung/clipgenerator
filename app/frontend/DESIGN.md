# clipgenerator design system — Desk

Use this for every UI change. Prefer tokens and shared component classes over one-off styles.

## Principles

1. **Warm editorial desk** — dark ink room, one paper sheet for reading/writing.
2. **Terracotta red pen** — single craft accent for playhead, marks, and one primary action per zone.
3. **Highlighter wash = clip range** — in-range / playhead lines on paper, not green chrome borders.
4. **Square desk** — `--radius-sm` 2px almost everywhere; no pills, no glow, no mesh gradients.
5. **Three columns** — Sources+Clips rail · paper center · craft (monitor / mark / export / post).
6. **Tokens are law** — no new hex in JSX; new colors get named tokens in `tokens.css` first.
7. **One primary per zone** — Add source · Export clip · Generate/Regenerate captions · Import clips.
8. **Mono for times and labels** — IBM Plex Mono; serif for anything a human wrote.
9. **Motion is quiet** — colour/background only, 120–180ms ease-out; playhead moves, little else animates.
10. **Behaviour stays frozen** — redesign is surface + IA, not product features.

## Fonts

| Role | Family | Load |
|------|--------|------|
| Human writing (titles, transcript, post, alerts) | **Newsreader** 400 / 500 / 400 italic | `@fontsource/newsreader` |
| Controls / UI | **Instrument Sans** 400 / 500 / 600 | `@fontsource/instrument-sans` |
| Times, paths, section labels | **IBM Plex Mono** 400 / 500 | `@fontsource/ibm-plex-mono` |

Stacks: `--font-serif`, `--font-sans`, `--font-mono`.

## Brand

| Element | Spec |
|---------|------|
| Name | **clipgenerator** (Newsreader 500 20px) |
| Tagline | `a local clip desk` (Newsreader italic 13px, accent-hover) |
| Mark | Brackets + filled playhead dot — SVG path in `App.jsx` (`stroke-width: 1.6`) |
| Feel | Editorial desk; terracotta pen; paper transcript |

## Layout

```
header 56px
sidebar 248px | center (flex) | craft 404px
```

- **Sidebar:** SOURCES → divider → CLIPS (scrolls) → folder/reveal foot.
- **Center:** source head, pane tabs (Agent | Transcript | Captions | Post | Publish), paper, hint row.
- **Craft:** monitor 158px, source ruler 44px, Clip, Caption plate. Export + Publish live on the Publish tab.
- Transcript measure hard-capped at `--paper-measure` (66ch).
- Full viewport height; columns scroll internally (no page scroll at desktop widths).
- ≤1280px craft narrows to 360px; ≤960px stacks.

## Type scale

| Token | Size | Use |
|-------|------|-----|
| `--text-display` | 34px | Empty headline (serif 500) |
| `--text-title` | 22px | Source title |
| `--text-title-sm` | 17px | Alert headlines |
| `--text-read` | 15px / 1.75 | Transcript body |
| `--text-read-sm` | 14px / 1.6 | Caption cue text |
| `--text-list` | 13.5px | Clip / source titles |
| `--text-ui` | 12.5px | Buttons, labels |
| `--text-ui-sm` | 11.5px | Secondary text actions |
| `--text-time` | 15px | In/out fields mono 500 |
| `--text-meta` | 10.5px | Mono meta lines |
| `--text-label` | 10px | Mono caps section labels, tracking `.14em` |

Utilities: `.text-display` · `.text-title` · `.text-read` · `.text-label` · `.text-meta` · `.text-mono`

## Color roles

| Token | Role |
|-------|------|
| `--color-bg` | App canvas (ink room) |
| `--color-surface` | Header / craft panel |
| `--color-surface-raised` | Inputs, nested controls |
| `--color-surface-sunken` | Center column behind paper |
| `--color-sidebar` | Library rail |
| `--color-paper` / `--color-paper-text*` | Only light surface |
| `--color-accent` | Terracotta primary / playhead |
| `--color-accent-ink` | Accent on paper (margin marks) |
| `--color-clip-range` / `--color-playing` | Highlighter washes on paper |
| `--color-range-strip*` | Ruler clip bars |
| `--color-success` / `--color-warning` / `--color-danger` | Status (+ `*-bg` / `*-text`) |

Status is a **coloured word** (`.status-word--ready|progress|error`), not a pill chip.

## Components (key classes)

- `.btn` / `.btn--primary` / `.btn--text` / `.btn--mark` — square, flat primary (no gradient)
- `.paper` / `.paper__margin` / `.transcript-line` — reading surface
- `.ruler` — display-only source duration strip
- `.clip-card` — shared list language with source `.list-item`
- `.pane-tab` — segmented control; Agent never gets special accent fill
- `.craft-zone` — Mark / Export / The post
- `.monitor` — full-source video; tag “full source — no clip-only player”
- Banners / jobs / alerts: tinted bg + **2px left border**, not full outline

## Pane tabs

`paneTab`: `'transcript' | 'captions' | 'post' | 'publish'`

- Public editor: no Agent tab. Publish is **Export** only.

## Terminology

**source**, **clip**, **in / out**, **playhead**, **captions**, **post**.  
“Cut” only as a verb. Never “shelf” or “today’s folder” as a UI label.

## Files

| File | Role |
|------|------|
| `src/styles/tokens.css` | Desk tokens (from design handoff) |
| `src/styles/base.css` | Reset, type utilities, selection, scrollbars |
| `src/styles/components.css` | Buttons, paper, list, ruler, agent, empty |
| `src/styles/layouts.css` | Shell, three columns, header, craft |
| `src/App.jsx` | Product tree |
| `src/main.jsx` | Fonts + CSS entry |

## Out of scope (do not invent)

Caption burn-in, clip-only player, drag-to-trim, publish/schedule, in-app model calls, night-dimmed paper, mobile-first layouts.
