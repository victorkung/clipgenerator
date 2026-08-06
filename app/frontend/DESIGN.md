# clipgenerator design system

Use this for every UI change. Prefer tokens and shared component classes over one-off styles.

## Principles

1. **Quiet dark media tool** — dense but calm; not a marketing site or neon dashboard.
2. **One scale** — only use type / space / radius tokens from `src/styles/tokens.css`.
3. **Same control height** — buttons and inputs share `--control-h-*`.
4. **Same list language** — sidebar sources and clip rows both use `.list-item`.
5. **Tabular times** — use `.text-mono` (Inter + tabular nums) for timestamps; not a second font.

## Fonts

| Role | Family | Load |
|------|--------|------|
| UI (everything, including timestamps) | **Inter** 400 / 500 / 600 / 700 | `@fontsource/inter` in `main.jsx` (local) |

Timestamps and ranges use Inter with `font-variant-numeric: tabular-nums` (`.text-mono` class name is historical — not a second typeface).

Fallback: `ui-sans-serif, system-ui, sans-serif`.

Fonts ship with the app. After CSS changes, hard-refresh (`Cmd+Shift+R`).

## Type scale

| Token | Size | Use |
|-------|------|-----|
| `--text-xs` | 11px | Overlines, pills, section labels |
| `--text-sm` | 12.5px | Meta, secondary sidebar text |
| `--text-md` | 14px | Body, buttons, inputs, transcript |
| `--text-lg` | 16px | Emphasized body |
| `--text-xl` | 20px | Source / page title |
| `--text-2xl` | 24px | Empty-state headline |

Utility classes: `.text-display` · `.text-title` · `.text-body` · `.text-label` · `.text-meta` · `.text-mono`

## Color roles

| Token | Role |
|-------|------|
| `--color-bg` | App canvas |
| `--color-surface` | Panels / cards |
| `--color-surface-raised` | Nested controls / header |
| `--color-border` / `--color-border-subtle` | Borders / dividers |
| `--color-text` / `--color-text-secondary` / `--color-text-tertiary` | Text hierarchy |
| `--color-accent` | Primary actions & focus |
| `--color-success` / `--color-warning` / `--color-danger` | Status |
| `--color-clip-range` | Transcript lines inside clip range |

Do not introduce new hex values in component CSS unless adding a named token.

## Spacing (4px grid)

`--space-1` … `--space-10` → 4, 8, 12, 16, 20, 24, 32, 40 px.

## Radius & elevation

- `--radius-sm` 6px — pills  
- `--radius-md` 10px — inputs, buttons  
- `--radius-lg` 14px — cards, video, transcript  
- `--shadow-sm` / `--shadow-md` — header / panels  

## Components

| Class | Variants |
|-------|----------|
| `.btn` | `--primary` · `--ghost` · `--danger` · `--icon` · `--sm` |
| `.input` / `.select` | pair with `.field` label |
| `.pill` | `--ready` · `--error` · `--progress` |
| `.panel` | surface card |
| `.banner` | `--success` · `--warning` · `--error` · `--info` (global errors only; export uses `.export-status`) |
| `.export-status` | `--busy` · `--done` — local progress under clip-bar export actions |
| `.list-item` | `--active` |
| `.section-label` | overline + optional count |
| `.transcript-line` | `--active` · `--in-range` |
| `.pipeline` | progress steps + bar |
| `.pane-tab` | right-column tabs (`--active`); pair with `.pane-tabs` |
| `.caption-overlay` | burn-style preview over `.video-shell` |
| `.caption-row` | editable caption cue (`--active` when playhead matches) |

## Do / don’t

**Do**

- Use `btn btn--primary` for primary actions.
- Put times in `.text-mono`.
- Match list selection styles via `.list-item--active`.

**Don’t**

- Invent `font-size: 0.83rem` mid-feature.
- Mix `border-radius: 8px` and `12px` on the same control type.
- Style “selected” differently in sidebar vs clip list.

## Adding UI

1. Check tokens in `tokens.css`.  
2. Prefer an existing component class.  
3. If truly new, add a named token + class in `components.css`, document here briefly.  
4. Avoid page-only magic numbers in `app.css` unless layout-only.
