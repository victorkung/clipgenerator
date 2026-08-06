# clipgenerator design system

Use this for every UI change. Prefer tokens and shared component classes over one-off styles.

## Principles

1. **Premium dark studio** — Descript-class craft; local clip studio, not neon AI chrome.
2. **Warm amber on cool zinc** — single craft accent; solid green for Set in / in-range.
3. **Contrast first** — solid control fills (`--color-control-fill` / `--color-input-fill`); no transparent ghost buttons on dark panels.
4. **Clear surface steps** — bg &lt; sidebar &lt; surface &lt; raised &lt; control; borders at least ~0.12–0.2 white alpha.
5. **One scale** — only use type / space / radius / motion tokens from `tokens.css`.
6. **Same control height** — buttons and inputs share `--control-h-*`.
7. **Same list language** — sidebar sources and clip rows both use `.list-item`.
8. **Mono for times** — JetBrains Mono via `.text-mono` / `.input--mono`.
9. **One primary per zone** — Mark / Export / Post each have a clear primary action.
10. **Motion is quiet** — short ease-out transitions; no gratuitous animation.
11. **Tokens are law** — no new hex in JSX; new colors get named tokens first.

## Fonts

| Role | Family | Load |
|------|--------|------|
| UI | **Inter** 400 / 500 / 600 / 700 | `@fontsource/inter` |
| Times / code | **JetBrains Mono** 400 / 500 / 600 | `@fontsource/jetbrains-mono` |

Fallback: `ui-sans-serif, system-ui, sans-serif` / `ui-monospace, Menlo, monospace`.

Fonts ship with the app. After CSS changes, hard-refresh (`Cmd+Shift+R`).

## Brand

| Element | Spec |
|---------|------|
| Name | **clipgenerator** |
| Tagline | `local clip studio` (`.brand__tag`) |
| Mark | In/out brackets + playhead glyph (`.brand-mark` + SVG) — not letter monogram |
| Feel | Quiet graphite, single cool accent, craft microcopy |

## Type scale

| Token | Size | Use |
|-------|------|-----|
| `--text-xs` | 11px | Overlines, pills, section labels |
| `--text-sm` | 13px | Meta, secondary sidebar text |
| `--text-md` | 14px | Body, buttons, inputs, transcript |
| `--text-lg` | 16px | Emphasized body / agent step titles |
| `--text-xl` | 22px | Source / page title |
| `--text-2xl` | 28px | Empty-state headline |

Utility classes: `.text-display` · `.text-title` · `.text-body` · `.text-label` · `.text-meta` · `.text-mono`

## Color roles

| Token | Role |
|-------|------|
| `--color-bg` | App canvas |
| `--color-surface` | Panels / cards |
| `--color-surface-raised` | Nested controls / header |
| `--color-sidebar` | Library rail |
| `--color-border` / `--color-border-subtle` | Borders / dividers |
| `--color-text` / `--color-text-secondary` / `--color-text-tertiary` | Text hierarchy |
| `--color-accent` / `--color-accent-strong` / `--color-accent-hover` | Warm amber craft primary & focus |
| `--color-timeline-*` | Source-duration range strip (range + playhead) |
| `--color-on-accent` | Text on primary buttons / mark |
| `--color-tab-active-bg` | Selected main/pane tabs |
| `--color-success` / `--color-warning` / `--color-danger` | Status |
| `--color-clip-range` | Transcript lines inside clip range |
| `--color-playing` | Playhead transcript line |
| `--glow-accent` / `--glow-success` | Quiet shell ambient washes |

Do not introduce new hex values in component CSS unless adding a named token.

## Spacing (4px grid)

`--space-1` … `--space-10` → 4, 8, 12, 16, 20, 24, 32, 40 px.

## Radius & elevation

- `--radius-sm` 6px — pills, small controls  
- `--radius-md` 10px — inputs, buttons  
- `--radius-lg` 16px — cards, video, transcript  
- `--radius-pill` 999px — range chips, progress tracks  
- `--shadow-sm` / `--shadow-md` / `--shadow-primary` — header / panels / CTAs  

## Components

| Class | Variants / notes |
|-------|------------------|
| `.btn` | `--primary` · `--ghost` · `--danger` · `--icon` · `--sm` |
| `.input` / `.select` | pair with `.field` label; `.input--mono` for times |
| `.pill` | `--ready` · `--error` · `--progress` · `--info` |
| `.panel` | surface card |
| `.banner` | `--success` · `--warning` · `--error` · `--info` (global errors) |
| `.job-status` | `--busy` · `--done` · `--error` — local job feedback (export, agent steps) |
| `.export-status` | legacy alias of job-status pattern |
| `.list-item` | `--active` · `--panel` |
| `.section-label` | overline + optional count / actions |
| `.craft-zone` | Mark / Export / Post sections inside clip craft panel |
| `.transcript-line` | `--active` · `--in-range` |
| `.pipeline` | ingest progress steps + bar |
| `.main-tab` / `.pane-tab` | mode and right-column tabs (`--active`) |
| `.caption-overlay` | burn-style preview over `.video-shell` |
| `.caption-row` | editable caption cue (`--active` when playhead matches) |
| `.agent-flow` / `.agent-step` / `.agent-chip` | optional LLM handoff (feature-flagged) |
| `.brand-mark` | cut-mark SVG tile |
| `.kbd` | keyboard shortcut chip |
| `.range-chip` | in/out duration; `--in` when playhead inside |

## Layout regions

| Region | Classes |
|--------|---------|
| Shell | `.app` · `.top` · `.layout` · `.sidebar` · `.main` |
| Ingest | `.ingest` |
| Editor craft | `.clip-bar` > `.craft-zone` (Mark / Export / Post) |
| Workspace | `.workspace` · `.player-col` · `.transcript-col` |
| Empty | `.empty-main` |

## Keyboard (Editor)

| Key | Action |
|-----|--------|
| `I` | Set start @ playhead (ignored while typing) |
| `O` | Set end @ playhead |
| ⌥/Alt + transcript line | Set start |
| ⇧ + transcript line | Set end |
| Enter in Start/End | Apply times + seek |

## Do / don’t

**Do**

- Use `btn btn--primary` for the one primary action in a zone.
- Put times in `.text-mono`.
- Match list selection styles via `.list-item--active`.
- Put long-job feedback in `.job-status` next to the action (not only top banner).

**Don’t**

- Invent `font-size: 0.83rem` mid-feature.
- Mix `border-radius: 8px` and `12px` on the same control type.
- Style “selected” differently in sidebar vs clip list.
- Put one-off colors/sizes in JSX.

## Adding UI

1. Check tokens in `tokens.css`.  
2. Prefer an existing component class.  
3. If truly new, add a named token + class in `components.css` / `layouts.css`, document here briefly.  
4. Avoid page-only magic numbers unless layout-only and token-backed.
