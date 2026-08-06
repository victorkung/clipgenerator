# clipgenerator — Design review & redesign plan

**Status:** Approved and implemented (Phases 0–4) — see `CHANGELOG.md` `[Unreleased]`  
**Scope:** End-to-end product/UI/UX + brand for the local daily-driver monorepo  
**Audience:** Product owner + implementer (this agent)  
**Code anchors:** `app/frontend/src/App.jsx`, `app/frontend/src/styles/*`, `app/frontend/DESIGN.md`

---

## 0. Executive summary

clipgenerator already has a **solid bones design system** (tokens, Inter, quiet dark surfaces, list/pill/pipeline language) and a **working Editor** that ships the open-source core. The optional **Agent flow** is sequential and legible, but secondary.

What holds the product back is not “more neon AI chrome.” It is:

1. **Action hierarchy collapse** — too many equal-weight primary buttons in the clip craft surface.
2. **Instrument fragmentation** — times, transcript, post package, captions, and export live in one tall stack without clear zones.
3. **Brand under-expression** — generic “cg” + cyan-blue SaaS default; tagline markets the stack, not the job.
4. **Token/doc drift** — hardcoded hex and radius in CSS; `DESIGN.md` slightly out of sync with `tokens.css`.
5. **Trust gaps on long jobs** — pipeline is good for ingest; export/media reveal and error recovery are thinner.
6. **Mode clarity is almost there** — Editor vs Agent tabs work, but Agent feels like a form wizard detached from the source instrument.

**Recommended direction:** Keep the quiet dark media-tool soul. Tighten craft surfaces, progressive disclosure, and job trust. Express a distinct **local clip studio** brand through type weight, accent restraint, microcopy, and a sharper wordmark — not gradients and glow.

**Implementation philosophy:** Token-first, CSS-class-first, minimal JSX structure change until Phase 1–2; only split `App.jsx` if a phase explicitly needs it (recommended late, optional).

---

## 1. Current-state audit

### 1.1 Information architecture (today)

```text
┌─ sticky header ─────────────────────────────────────────────┐
│  brand (cg + clipgenerator)     ingest [URL | model | Ingest]│
└─────────────────────────────────────────────────────────────┘
│ error banner (global)                                       │
┌─ sidebar ──┬─ main ─────────────────────────────────────────┐
│ Sources    │ source head (title, meta, rename/remove)       │
│  · status  │ pipeline (if not ready)                        │
│  · clips n │ main-tabs: Editor | Agent flow  (flag)         │
│            │                                                │
│            │ [Editor] workspace grid:                       │
│            │   left: video · clip-bar (dense) · clip list   │
│            │   right: Transcript | Captions                 │
│            │                                                │
│            │ [Agent] steps 1–3 panels (no video)            │
└────────────┴────────────────────────────────────────────────┘
```

| Region | Classes / files | Role |
|--------|-----------------|------|
| Shell | `.app`, `.top`, `.layout`, `.sidebar`, `.main` — `layouts.css` | App chrome |
| Brand | `.brand`, `.brand-mark` — `layouts.css` / `components.css` | Identity |
| Ingest | `.ingest` — `layouts.css` + form in `App.jsx` | Entry |
| Sources | `.list-item`, pills — `components.css` | Library |
| Pipeline | `.pipeline` — `components.css` + `PipelineProgress` | Long job trust |
| Mode tabs | `.main-tabs` / `.main-tab` — `layouts.css` | Editor vs Agent |
| Clip craft | `.clip-bar`, `.range-chip`, `.post-package` — `layouts.css` | Core editor |
| Transcript | `.transcript-line` — `components.css` | In/out by speech |
| Captions | `.caption-row`, overlay — `layouts.css` | Clip-relative cues |
| Export feedback | `.export-status` — `layouts.css` | Encode progress |
| Agent flow | `.agent-flow`, `.agent-step`, `.agent-chip` — `layouts.css` | LLM handoff |

**Single React tree:** almost all UI lives in `App.jsx` (~1.7k lines). Design system is mature enough that most redesign is **layout + component classes**, not a rewrite.

### 1.2 Journey A — Core Editor (primary / public)

| Step | What happens | UI surface | Friction |
|------|--------------|------------|----------|
| A1 Empty | Paste URL | Header ingest + empty main | Empty state is calm; no model guidance beyond tiny hint under field |
| A2 Ingest | Download + Whisper | Pipeline + sidebar pill | Good stage language; no ETA; X promo-clip duration only in README, not proactive banner |
| A3 Ready | Open source | Source head + Editor | Tabs only appear when Agent flag on — good |
| A4 Scrub | Play + transcript seek | Video + right pane | Works; no transport shortcuts beyond native video |
| A5 Mark in/out | Set start/end, type times, ⌥/⇧ lines | Clip bar + transcript | **Two `btn--primary` for start/end**; type+Apply is strong; shortcut only for lines |
| A6 Multi-clip | + New clip, list below | Clip list under bar | List far from video; active selection OK via `.list-item--active` |
| A7 Captions | Generate → Captions tab | Overlay + editor | Mental model explained in empty state; **stale warning good**; still easy to miss clip-relative note |
| A8 Export | Export clip / all | Button row + `.export-status` | Progress local under buttons (good); **no Reveal in Finder** for media path (API exists); path is monospace dump |
| A9 Post | Edit `post_text`, copy | Nested under clip-bar | Useful; **same visual weight whether empty or filled**; tags read-only |

### 1.3 Journey B — Agent flow (secondary / flagged)

| Step | What happens | UI surface | Friction |
|------|--------------|------------|----------|
| B1 Brief | Optional notes | Step 1 textarea | Clear |
| B2 Summary export | Package + auto-reveal folder | Primary button | Success reuses `exportMsg` (shared with media export/captions) |
| B3 Paste summary URL | Step 2 field | Clear gating on Clip export |
| B4 Clip export | Package + reveal | Primary button | Same busy flag as summary (`briefBusy`) — OK |
| B5 Import plan | Paste/file JSON | Large textarea | Placeholder schema helps; validation errors go to global banner |
| B6 Editor polish | Switch to Editor | Ghost “Open Editor” + auto-switch on import | Good; no “you imported N clips” sticky in Editor |
| B7 Export media | Same as A8 | Editor | Post package lights up when plan had `post_text` |

**Flag behavior:** `CLIPGENERATOR_AGENT_FLOW` via `/api/health` → `agentFlowEnabled`. Editor-only path must remain excellent when flag is off (no tabs, no agent chrome).

### 1.4 What already works (protect these)

- Quiet dark baseline + Inter + tabular times (`.text-mono` name historical, correct)
- Pipeline stages for ingest (dots + bar + message)
- Transcript highlight: playhead (amber) vs in-range (green bar)
- Typed Start/End + Enter/Apply seeks player + transcript
- Export progress **scoped under export actions**, cleared on source switch
- Captions stale detection after in/out change
- List language shared sidebar ↔ clip rows
- Agent sequential chips (Brief / Summary URL / Plan imported)
- Feature flag keeps public surface clean

### 1.5 Issues by priority

#### P0 — hurts daily craft or trust

| ID | Issue | Evidence |
|----|-------|----------|
| P0-1 | **Primary action soup** in clip-bar: Set start, Set end, Export all primary-weight or adjacent equal rows | `App.jsx` clip-bar rows; both Set start/end use `btn--primary` |
| P0-2 | **Clip instrument is one tall panel** — mark times, export, captions, post package stacked without zones | `.clip-bar` + `.post-package` in one `.panel` |
| P0-3 | **Failed ingest / STT has no recovery CTA** | API `POST …/retry-transcribe` exists; UI never calls it |
| P0-4 | **Export path is not actionable** | `api.revealPath` used for agent packages only; media export shows raw path |
| P0-5 | **Shared success channel** (`exportMsg`) mixes media export, captions, agent package, import | Easy to misread “what just finished” |

#### P1 — clarity, modes, progressive disclosure

| ID | Issue | Evidence |
|----|-------|----------|
| P1-1 | Brand tagline is **stack marketing** (“local · multi-clip · whisper”), not product job | `.brand__tag` |
| P1-2 | Agent flow **detaches from media** — no duration/title context, no “open editor” sticky | `.agent-flow` replaces workspace |
| P1-3 | Clip list **below** craft panel → scroll to switch clips | `.clip-list` after `.clip-bar` |
| P1-4 | Keyboard power is **half-discoverable** (⌥/⇧ only); no I/O / JKL-style marks | Transcript meta only |
| P1-5 | Whisper model guide is excellent but **hidden under dense header** on narrow widths | `.ingest__hint` |
| P1-6 | X promo-clip duration surprise not in UI | README only |
| P1-7 | Token/CSS **hardcoded hex** breaks “tokens only” rule | e.g. `#0a0d12`, `#3a8ee0`, `rgba(110,168,255,…)` in layouts/components |
| P1-8 | `DESIGN.md` type/radius numbers **disagree with tokens** | xl 20 vs 22; radius-lg 14 vs 16 |

#### P2 — polish, brand, density

| ID | Issue | Evidence |
|----|-------|----------|
| P2-1 | Brand mark “cg” is generic SaaS tile | `.brand-mark` |
| P2-2 | Subtle radial gradients on `.app` are fine but unowned | Ambient cyan/green washes without brand story |
| P2-3 | Sidebar lacks duration / ready-first sort / date | List meta = status + clip count only |
| P2-4 | Empty state icon “▶” is placeholder energy | `.empty-main__icon` |
| P2-5 | Post package always visible even when empty (OK for Agent users; noise for pure Editor) | Always rendered when `activeClip` |
| P2-6 | No global toast/status region hierarchy (error vs job vs local) | Error banner top; export local; agent reuses export |
| P2-7 | Mobile breakpoint stacks OK but clip craft remains button-heavy | `@media (max-width: 960px)` |
| P2-8 | `App.jsx` monolith will slow iterative UI phases | 1743 lines, single file |

### 1.6 Design-system health

| Strength | Debt |
|----------|------|
| Clear component vocabulary | Many one-off colors not in tokens |
| Documented principles match product | Doc numbers drift from CSS |
| Control heights unified | Active tab color not tokenized |
| Progress patterns exist (banner, pipeline, export-status) | Three patterns slightly inconsistent |

---

## 2. Design principles (target)

1. **Editor is the product.** Agent flow is an advanced handoff — never the first thing a public user sees.
2. **One primary action per zone.** Marking, exporting, packaging, and posting are different intents; visual weight must match.
3. **Transcript + timeline = one instrument.** In/out, playhead, and range must feel linked (they almost do; reinforce, don’t reinvent).
4. **Trust beats spectacle during long jobs.** Stages, %, cancel/retry where real, and open-on-disk for outputs.
5. **Progressive disclosure.** Captions and post package collapse until needed; power shortcuts exist for regulars.
6. **Dense but calm.** Prefer grouping and quieter secondaries over more chrome or larger cards.
7. **Local studio, not AI product marketing.** No purple gradients, no “powered by” theater; brand = craft + locality.
8. **Tokens are law.** No new hex in JSX; new colors get named tokens; `DESIGN.md` stays truthful.

---

## 3. Target information architecture

```text
┌─ app shell ─────────────────────────────────────────────────┐
│ brand | source context (when selected) | ingest compact     │
│ status strip: global error OR quiet job chip (non-blocking) │
├─ library ─┬─ workspace ─────────────────────────────────────┤
│ Sources   │ source header + mode switch (Editor | Agents*)  │
│ (ready↑)  │                                                 │
│           │ Editor mode:                                    │
│           │  ┌ player ─────────┐ ┌ right dock ───────────┐  │
│           │  │ video + overlay │ │ Transcript | Captions │  │
│           │  ├ clip rail ──────┤ │ (sticky)              │  │
│           │  │ active clip     │ └───────────────────────┘  │
│           │  │ mark · times    │                            │
│           │  │ export zone     │                            │
│           │  │ post (optional) │                            │
│           │  ├ clip list ──────┤  (rail: list can sit      │
│           │  └─────────────────┘   under mark OR as strip)  │
│           │                                                 │
│           │ Agent mode*: stepper + packages + import        │
│           │  (source meta sticky; “Back to Editor”)         │
└───────────┴─────────────────────────────────────────────────┘
* Agent mode only when CLIPGENERATOR_AGENT_FLOW=1
```

### Mode model

| Mode | Audience | Goal |
|------|----------|------|
| **Editor** | Everyone | Mark, caption, export, copy post |
| **Agent flow** | Power / daily driver with external LLM | Package → external judgment → import → back to Editor |

No third top-level mode. Settings stay in ingest (model) + implicit filesystem layout.

### Clip craft zones (Editor left column)

| Zone | Contents | Primary CTA |
|------|----------|-------------|
| **Player** | Video, caption overlay | — |
| **Mark** | Title, range chip, Start/End, Set/Jump, shortcut hint | Set end (or “Apply range”) — not dual equal primaries |
| **Export** | Export clip / all + status + Reveal | Export clip |
| **Post** | Collapsible post package | Copy post |
| **Clips** | Multi-clip list | Select / + New |

---

## 4. Wireframe-level redesigns

ASCII only — implementable with existing grid + new section classes.

### 4.1 Shell / brand

```text
┌──────────────────────────────────────────────────────────────┐
│ [◼︎ mark] clipgenerator          ╭ URL ────────╮ [model▾] [Ingest]
│          local clip studio       ╰ whisper hint ─────────────╯
└──────────────────────────────────────────────────────────────┘
```

- Wordmark: **clipgenerator** (keep product name); mark evolves from “cg” tile → **cut-bar glyph** (abstract in/out marks or film frame with playhead).
- Tag: **local clip studio** (or **cut · caption · export**). Drop stack laundry list from chrome.
- Optional: when a source is selected, a compact **context chip** (title truncated · duration · ready) can sit between brand and ingest on wide screens — Phase 1+.

### 4.2 Ingest + empty

```text
                    ┌ empty ─────────────────────┐
                    │   [cut mark icon]           │
                    │   Cut clips from long video │
                    │   Download · on-device STT  │
                    │   · mark with transcript    │
                    │                             │
                    │   Paste a URL in the bar ↑  │
                    └─────────────────────────────┘
```

- Keep header as primary ingest (muscle memory).
- Empty copy emphasizes **job**, not tech brands.
- After first source exists, empty is rare; sidebar empty state stays dashed card.

### 4.3 Ingest progress / error

```text
source head …
┌ pipeline ─────────────────────────────────────┐
│ ● Resolve  ● Download  ◉ Transcribe  ○ Ready  │
│ ████████████░░░░  62%  Transcribing (small)…  │
│ detail line…                                  │
└───────────────────────────────────────────────┘

error:
│ status error · message                        │
│ [Retry transcribe]  [Remove]                  │
```

- Surface **Retry transcribe** when video exists / stage failed at STT (wire existing API).
- If duration &lt; ~90s after download, optional **info chip**: “Short source — some X posts are promo clips, not full episodes.”

### 4.4 Editor (target)

```text
[ Editor | Agent flow ]

┌ player col ──────────────────┐  ┌ right ──────────────────┐
│ ┌ video ───────────────────┐ │  │ [Transcript] [Captions] │
│ │         overlay cue      │ │  │ ⌥ start · ⇧ end · I/O   │
│ └──────────────────────────┘ │  │ ┌────────────────────┐  │
│                              │  │ │ 12:04  line…       │  │
│ ┌ MARK ────────────────────┐ │  │ │ 12:08  line…  ║    │  │
│ │ Title ________  1:02→1:48│ │  │ │ … in-range green  │  │
│ │ Start [1:02] End [1:48]  │ │  │ └────────────────────┘  │
│ │ [Set start] [Set end★]   │ │  └─────────────────────────┘
│ │ Jump start · Jump end    │ │
│ └──────────────────────────┘ │
│ ┌ EXPORT ──────────────────┐ │
│ │ [Export clip★] Export all│ │
│ │ Generate captions · …    │ │
│ │ ░ progress / ✓ path      │ │
│ │ [Reveal in Finder]       │ │
│ └──────────────────────────┘ │
│ ┌ POST ▾ (collapsed empty) ┐ │
│ │ X post text · Copy …     │ │
│ └──────────────────────────┘ │
│ CLIPS (n)  [+ New clip]      │
│ ○ clip rows…                 │
└──────────────────────────────┘
```

**Key moves:**

- Split clip-bar into **Mark / Export / Post** subpanels (same column, clearer labels via `.section-label`).
- Only **one** strong primary in Mark (recommend **Set end** as finish-mark, Set start secondary — or both secondary with **Apply** as primary when drafts dirty).
- Export zone owns media encode feedback only.
- Post package **collapsed by default** if `!post_text && !why`; expanded when plan-imported or user opens.
- Clip list gains **+ New** in section header (not only buried mid-export row).

### 4.5 Agent flow

```text
[ Editor | Agent flow* ]

source meta strip (title · duration · ready)   [← Editor]

Brief · Summary URL · Plan imported   (chips)

1 Summary package
   brief textarea
   [Export for Summary agent] → status local to step

2 Clip package
   summary URL
   [Export for Clip agent]

3 Import plan
   JSON · file · [Import clips] → on success: banner + force Editor
```

- Per-step **local status** (not global `exportMsg`).
- Step 2 disabled styling until URL present (already).
- Intro copy shorter: “External LLM judges; this app owns media.”
- Optional link to public `prompts/AGENT_PIPELINE.md` in UI meta (path/docs, not private packs).

### 4.6 Export progress pattern

Unify under one component pattern `.job-status` (alias or evolve `.export-status`):

| State | Visual |
|-------|--------|
| Busy | warning muted, spinner, % track, non-dismissible |
| Done | success muted, path + **Reveal**, click/dismiss |
| Error | danger muted, message + retry if applicable |

Do **not** promote encode progress to the full-width top banner (current local placement is correct).

### 4.7 Post package

```text
POST PACKAGE                    [Copy post]
Why · optional one-liner
┌ textarea ──────────────────┐
│ lowercase quote body…      │
└────────────────────────────┘
[Copy summary URL] [Copy source URL]
Tags · @host @guest
```

- Character count optional (X soft limit awareness) — Phase 4 nice-to-have, not required.
- Keep manual X post (no auto-post).

---

## 5. Brand system (implementable)

### 5.1 Positioning

| | |
|--|--|
| **Product** | clipgenerator |
| **Category** | Local clip studio for long video → short posts |
| **For** | Single-user creators/editors who care about transcript-tight cuts |
| **Not** | Cloud SaaS, multiplayer, auto-posting social suite, “AI clip finder” (yet) |
| **Promise** | Download, hear every line, cut many clips, export clean H.264 — on your machine |

### 5.2 Personality

| Trait | In UI means |
|-------|-------------|
| **Quiet** | Dark graphite, low glow, no confetti |
| **Precise** | Tabular times, sharp range states, honest % |
| **Craft** | Microcopy like “Set start,” “Reveal,” “Clip-relative” — tool words |
| **Local** | Paths, Finder, on-device STT — never pretend cloud |
| **Calm confidence** | One accent; success green for “in range / ready,” not celebration |

**Do not** pivot to neon purple “agentic” aesthetics. Agent flow is a **workflow**, not the brand.

### 5.3 Name & wordmark

- **Product name stays** `clipgenerator` (repo + brand continuity).
- **Mark direction (implement in CSS/SVG inline):** abstract **in/out brackets** or a small **playhead on a bar** inside the existing 36×36 tile — still monochrome-on-accent.
- **Wordmark:** Inter 700, tight tracking (existing `--tracking-title`).
- **Tagline options (pick one in Phase 4):**
  1. `local clip studio` *(recommended)*
  2. `cut · caption · export`
  3. Keep technical tag only in About/README, not header

### 5.4 Color (token-level)

**Keep the graphite + single cool accent.** Refine, don’t reinvent.

| Token | Current | Proposed (if changing) | Role |
|-------|---------|------------------------|------|
| `--color-bg` | `#080a0e` | keep | Canvas |
| `--color-surface` | `#0f131a` | keep | Panels |
| `--color-surface-raised` | `#161c26` | keep | Header/controls |
| `--color-accent` | `#5eb0ff` | keep or slightly desaturate → `#6aa8e8` | Focus / links |
| `--color-accent-strong` | `#2f7fd4` | keep | Primary buttons |
| `--color-clip-range` | green tint | keep | In-range transcript |
| `--color-playing` | amber tint | keep | Playhead line |
| **New** `--color-sidebar` | hardcoded `#0a0d12` | **tokenize** | Sidebar wash |
| **New** `--color-btn-hover` | hardcoded `#1e2636` | **tokenize** | Default btn hover |
| **New** `--color-on-accent` | `#fff` | **tokenize** | Text on primary |
| **New** `--color-tab-active-bg` | ad-hoc rgba | **tokenize** from accent-muted | Tab selected |

Ambient gradients: reduce intensity **or** bind to tokens (`--glow-accent`, `--glow-success`) so brand control is central. Prefer **slightly quieter** glows.

### 5.5 Type

- **Keep Inter only** (local `@fontsource`). No second display face — density tools don’t need marketing serif.
- Sync `DESIGN.md` sizes to live tokens (`--text-xl` 22px, `--text-2xl` 28px, `--radius-lg` 16px).
- Optional Phase 4: slightly increase transcript line padding for long pods (comfort without leaving density).

### 5.6 Microcopy voice

| Instead of | Prefer |
|------------|--------|
| “Starting…” | “Queuing…” / “Starting download…” if stage known |
| “Ingest” | **Keep** — power users know it; alt “Add source” as title attribute |
| “Agent flow” | Keep label; intro: “Hand off to an external LLM, then import clips.” |
| Stack tagline | Job tagline |
| Raw path only | “Saved” + **Reveal in Finder** |
| “click to dismiss” | “Dismiss” (same affordance) |

### 5.7 Motion

- Existing: progress fill, pipeline pulse, spinner — **keep**.
- Avoid new page transitions. Optional 150ms hover on list items already present.

### 5.8 Justification for any aesthetic break

**No break from quiet dark.** The redesign **doubles down** on it. The only “brand lift” is:

- clearer mark + tagline,
- fewer competing primaries,
- tokenized surfaces,
- quieter ambient wash,

…which increases distinctiveness **without** looking like a 2025 AI landing page.

---

## 6. Interaction patterns

### 6.1 Long-running jobs

| Job | Pattern |
|-----|---------|
| Ingest | Pipeline panel + sidebar pill + poll (existing) |
| Export encode | Local `.export-status` under Export zone + poll (existing) |
| Captions generate | Button busy state; success → switch Captions tab (existing) |
| Agent package | **Per-step** busy/done (target) + auto-reveal folder (existing) |

Rules:

- Never use full-page modal for jobs.
- Don’t steal focus from video on % ticks.
- Clear export UI when switching sources (already).

### 6.2 Import / export

| Action | Feedback |
|--------|----------|
| Export clip/all | Busy % → done path + Reveal |
| Export agent package | Step status + Finder open |
| Import plan | Count + list titles/times → switch Editor + select first clip |
| Copy post/URL | Brief button label flip “Copied” 1.5s (Phase 0–2) |

### 6.3 Multi-clip

- Selecting a row seeks to `t_in` (existing).
- Active clip owns mark/export/post/captions.
- New clip from playhead + 30s default (existing) — move CTA to Clips header.
- Delete remains icon + confirm only if we add confirm later (today immediate delete — optional soft confirm Phase 2).

### 6.4 Keyboard (target)

| Key | Action | Phase |
|-----|--------|-------|
| ⌥/Alt + click line | Set start | exists |
| ⇧ + click line | Set end | exists |
| `I` | Set start @ playhead | Phase 2 |
| `O` | Set end @ playhead | Phase 2 |
| Enter in time field | Apply + seek | exists |
| Esc | Cancel title edit | exists |
| When focus in inputs | Don’t hijack I/O | required |

Show shortcut strip once near Mark zone + keep transcript meta.

### 6.5 Captions mental model

Persistent quiet hint when Captions tab active:

> Times are relative to this clip (0:00 = export start). You scrub the **source** video.

Stale banner stays.

---

## 7. Phased implementation plan

Implement **only after approval**, in order. Each phase is PR-sized; shippable alone.

### Phase 0 — Quick wins (low risk)

**Intent:** Hierarchy, copy, recovery, token hygiene starts — no IA surgery.

| Work | Files likely |
|------|----------------|
| Demote dual primary: Set start/end → primary only on one (or both secondary; Export clip sole primary in export row) | `App.jsx` classes |
| Group clip-bar rows with section labels (Mark / Export) without full layout rewrite | `App.jsx`, `layouts.css` |
| Wire **Retry transcribe** on error when applicable | `App.jsx`, `api.js` (if missing client method) |
| **Reveal in Finder** for export path (use `api.revealPath`) | `App.jsx` |
| Copy-feedback on Copy post / URLs | `App.jsx` |
| Tagline → `local clip studio` | `App.jsx` |
| Fix DESIGN.md token table sync | `DESIGN.md` |
| Tokenize 2–3 worst hardcoded colors (`--color-sidebar`, btn hover) | `tokens.css`, `components.css`, `layouts.css` |
| Separate agent package success from media `exportMsg` (local state) | `App.jsx` |
| CHANGELOG `[Unreleased]` notes | `CHANGELOG.md` |

**Success criteria:**

- Fewer equal primaries in Editor; export path openable; STT error has Retry; agent success doesn’t look like “export clip done.”

**Risk:** Low. Behavioral only + small CSS.

---

### Phase 1 — Shell / IA

**Intent:** Clear modes, calmer chrome, library usefulness.

| Work | Files likely |
|------|----------------|
| Source context in header or under tabs (title/duration) | `layouts.css`, `App.jsx` |
| Mode tabs visual polish via tokens (active state) | `tokens.css`, `layouts.css` |
| Agent mode: sticky “Back to Editor” + source meta strip | `App.jsx`, `layouts.css` |
| Sidebar: show duration when known; optional ready-first sort | `App.jsx` |
| Empty state copy + icon refinement (token-based) | `layouts.css`, `App.jsx` |
| Short-source info chip when duration suspiciously small | `App.jsx` |
| Quieter app ambient gradients via tokens | `tokens.css`, `layouts.css` |

**Success criteria:**

- Editor-only (flag off) feels intentional; Agent mode never loses source context; library scannable.

**Risk:** Medium layout CSS. Regression on sticky transcript / header height.

---

### Phase 2 — Editor craft surface

**Intent:** One instrument for clip craft.

| Work | Files likely |
|------|----------------|
| Formal Mark / Export / Post zones (classes `.craft-zone`, etc.) | `layouts.css`, `components.css`, `App.jsx` |
| Collapsible Post package | `App.jsx`, CSS |
| Move **+ New clip** to Clips header | `App.jsx` |
| Keyboard I / O (guard inputs) | `App.jsx` |
| Shortcut hint UI | `App.jsx`, CSS |
| Captions hint reinforcement | `App.jsx` |
| Optional: clip list sticky under player or denser rows | `layouts.css` |
| Export zone only owns encode status component | `App.jsx` |

**Success criteria:**

- New users can mark + export without scanning 12 equal buttons; power users get I/O; post is available without dominating pure cutters.

**Risk:** Medium. Most user-visible; protect transcript sticky and export polling.

**Sub-PR split if needed:**

- 2a Mark/Export zones + button hierarchy  
- 2b Post collapse + clip list chrome  
- 2c Keyboard  

---

### Phase 3 — Agent flow polish

**Intent:** Advanced but not abandoned.

| Work | Files likely |
|------|----------------|
| Per-step local status components | `App.jsx`, `layouts.css` |
| Stronger stepper (connector or numbered progress) | `layouts.css` |
| Shorter intro + link to public pipeline doc | `App.jsx` |
| Import success summary strip that persists one Editor session | `App.jsx` |
| Disable visual states for locked steps | CSS |
| Ensure flag-off: zero agent CSS impact on Editor | verify |

**Success criteria:**

- Daily-driver handoff is sequential and trustworthy; public Editor path unchanged with flag 0.

**Risk:** Medium state management (don’t break shared export polling).

---

### Phase 4 — Brand polish

**Intent:** Identity visible in UI, still quiet.

| Work | Files likely |
|------|----------------|
| New brand-mark glyph (CSS/SVG) | `components.css`, `App.jsx` |
| Final tagline + empty-state icon | `App.jsx`, CSS |
| Full hardcode sweep → tokens | all `styles/*` |
| `DESIGN.md` rewrite for new components/zones | `DESIGN.md` |
| Optional character count on post | `App.jsx` |
| README labels only if user-visible strings changed | `README.md` |
| Light motion/focus consistency audit | CSS |

**Success criteria:**

- Screenshot of header + Editor is recognizable as clipgenerator; DESIGN.md matches code; no orphan hex in component CSS.

**Risk:** Low–medium visual; easy to over-polish — stop when tokens clean and mark ships.

---

### Suggested dependency order

```text
Phase 0  →  Phase 1  →  Phase 2 (a→b→c)  →  Phase 3  →  Phase 4
```

Phases 3 and 4 can partially parallel after 2a if needed, but brand (4) should land on stable structure.

---

## 8. Non-goals (this redesign)

- Multi-tenant accounts, auth, cloud sync
- Auto-post to X / scheduling
- Caption burn-in (roadmap item — UI may leave room, not implement encode burn)
- Full NLE timeline / multi-track
- In-app LLM calls or loading private prompt packs
- Light theme
- Mobile-native app
- Splitting `App.jsx` into many files **unless** a phase becomes unmanageable (prefer CSS + light structure first)
- Changing folder layout under `videos/` or library schema
- Replacing Whisper model set or download engine

---

## 9. Open questions for product owner

1. **Primary mark action:** Prefer dual secondary + Apply, or **I/O NLE convention** with Set end as the emphasized finish?
2. **Post package default:** Collapsed when empty for everyone, or **always expanded** when Agent flag is on?
3. **Brand mark:** Approve “in/out bracket” glyph direction, or prefer monogram refinement of `cg`?
4. **Tagline:** Confirm `local clip studio` vs `cut · caption · export`.
5. **Retry scope:** Retry **transcribe only** vs full re-ingest when download fails?
6. **Clip delete confirm:** Keep instant delete or add confirm (sources already confirm)?
7. **Agent default for daily driver:** `serve.sh` keeps Agent=1 — should the tab label stay “Agent flow” or become “LLM handoff” / “Packages”?
8. **Implementation depth now:** Approve **all phases**, or **0–1 only** first (shell + quick wins), then reassess Editor craft?
9. **Component split:** OK to keep monolith through Phase 2, or do you want `Editor.jsx` / `AgentFlow.jsx` extracted when touching those surfaces?
10. **X short-clip warning:** Show automatically under ~90s, or only for `x.com` / `twitter.com` hosts?

---

## 10. Verification plan (for Phase 2 work)

After each approved phase:

| Check | How |
|-------|-----|
| Editor-only | `CLIPGENERATOR_AGENT_FLOW=0` (or health false) — no agent chrome |
| Agent on | `serve.sh` default — tabs + packages |
| Ingest progress | Paste URL, watch pipeline + sidebar pills |
| Mark + transcript | Set start/end, ⌥/⇧, typed times |
| Export | Export clip → % → path → Reveal |
| Captions | Generate, edit, stale after range change |
| Import plan | Paste schema example → clips + Editor |
| Visual system | No new inline colors in JSX; hard-refresh CSS |
| Docs | `DESIGN.md` + `CHANGELOG` updated when user-visible |

Do not require full Whisper re-download for pure CSS/hierarchy phases.

---

## 11. Success criteria (overall)

**Phase 1 (this doc):** Owner can approve/reject without another discovery pass.

**Phase 2 (implementation):**

- App feels redesigned in **approved** ways only.
- Editor-first path is first-class with flag off.
- Brand is visible (mark, tagline, hierarchy), not only documented.
- Long jobs remain trustworthy.
- Token discipline holds.

---

## 12. Recommendation (for approval)

| Priority | Proposal |
|----------|----------|
| Ship first | **Phase 0 + Phase 1** — trust + hierarchy + shell |
| Then | **Phase 2** — Editor craft (biggest daily-driver win) |
| Then | **Phase 3** — Agent polish |
| Finish | **Phase 4** — brand mark + token sweep |

Default recommendation if you want one answer: **approve Phases 0–2** (quick wins through Editor), hold 3–4 for a second pass after living with craft zones.

---

*End of Phase 1 deliverable. No UI implementation performed beyond this document.*
