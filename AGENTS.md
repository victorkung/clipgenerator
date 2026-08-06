# Agent instructions

## Git gatekeeper (mandatory)

**The human does not run `git` commits.** Only the agent creates commits, and only when the human asks to commit, ship, or publish a change.

Before **every** commit, complete this checklist in order. **Do not commit if any hard fail is open.**

### 1. Intent

- [ ] Human explicitly asked to commit, ship, release, or publish (or clearly approved a proposed commit).
- [ ] Commit scope matches what they asked for — no drive-by files.

### 2. Secret & privacy scan (hard fail)

Run and inspect before staging:

```bash
git status
git diff
git diff --cached
```

Also scan staged/unstaged paths for secrets and private data:

| Must never be committed | Why |
|-------------------------|-----|
| `.env` | API keys / local config |
| Anything under `videos/` | Downloaded media, transcripts, audio extracts, exports |
| Anything under `data/` | Local library / project DB |
| `.venv/`, `node_modules/` | Environment noise |
| `*.audio.m4a`, `*.transcript.json`, `*.transcript.txt` | Derived private artifacts |
| Real API keys/tokens in any file | Credential leak |
| Cookies, browser export files, session dumps | Account compromise |

**Hard fail if:**

- `.env` is tracked or staged
- Any path under `videos/` or `data/` is staged
- `git grep` / diff shows a live-looking key (`xai-…`, `sk-…`, `Bearer …`, long high-entropy secrets)
- `.gitignore` no longer covers `.env`, `videos/`, `data/`, `.venv/`

If a secret was ever committed historically, **stop** and rotate/remediate — do not “fix forward” by committing more on top without telling the human.

### 3. Public-repo fitness (hard fail for public `main`)

This repo is **Option 1: one public daily-driver repo**. Every commit must be safe if the remote is public.

- [ ] No personal notes, client names, or private URLs that shouldn’t be public
- [ ] No large binaries or media
- [ ] README / `.env.example` never ship real keys; STT is **local Whisper** (no required cloud key)
- [ ] New scripts don’t hardcode keys or absolute personal paths that leak identity unnecessarily (`MODEL_DIR` examples are fine)

### 4. Sanity on the change (soft → hard if broken)

- [ ] `bash -n scripts/*.sh` (syntax)
- [ ] If Python changed: `python3 -m py_compile` on touched modules (prefer `.venv/bin/python`)
- [ ] Scripts that should be executable still are (`download.sh`, `to-h264.sh`, `transcribe.sh`, `serve.sh`)
- [ ] README / docs match behavior if flags or layout changed

Do **not** require a full download/STT round-trip for every commit (bandwidth + model time). Only run live download/STT when the human asks or the change is in that path and needs proof.

### 5. Stage deliberately

```bash
git status
# stage only intended paths — never `git add .` / `git add -A` if status shows
# ignored junk, videos, data, or .env (verify with git status after staging)
git add <explicit paths>
git status   # re-check staged set
```

Prefer explicit paths over blanket adds. After staging, confirm the index does **not** include secrets, `videos/`, or `data/`.

### 6. Commit message

- [ ] Read recent `git log` and match tone/style
- [ ] Message focuses on **why**, complete sentences, relevant detail only
- [ ] HEREDOC form:

```bash
git commit -m "$(cat <<'EOF'
Commit title.

Optional body.
EOF
)"
```

### 7. After commit

```bash
git status   # confirm clean (or only expected leftovers)
```

- Do **not** `git push` unless the human asked to push/publish.
- Do **not** amend unless the usual amend conditions in global git rules are all met.
- Do **not** force-push, skip hooks, or rewrite shared history unless explicitly requested.

---

## Session bootstrap (read this first — keep context small)

This file is **auto-loaded** every Grok session in this repo. Do **not** re-read the whole tree at start. Only open extra files when the task needs them.

| Need | Open |
|------|------|
| Human how-to / run app | `README.md` |
| Public repo policy | `docs/PUBLIC_REPO.md` |
| What changed recently | `CHANGELOG.md` `[Unreleased]` |
| UI styles (Desk theme) | `app/frontend/DESIGN.md` + `app/frontend/src/styles/` |
| Download defaults | `scripts/download.sh`, `config/yt-dlp.conf` |
| STT | `scripts/transcribe.py` / `scripts/transcribe.sh` |
| API / ingest / export | `app/backend/main.py` |
| Folder naming | `app/backend/naming.py` |
| UI editor | `app/frontend/src/App.jsx` |

### Product (clipgenerator)

- **Repo:** single public app `victorkung/clipgenerator` (see `docs/PUBLIC_REPO.md`). Agent prompts: browser localStorage + gitignored `data/` (never commit). Optional local packs under gitignored `prompts/private/`.
- **Flow:** URL → yt-dlp download → MLX Whisper STT → multi-clip editor → H.264+AAC export under `videos/…/clips/`.
- **Run UI:** `./scripts/serve.sh` → `:8787` · `cd app/frontend && npm run dev` → `:5173` (proxies `/api`). No `RELOAD=1` during long jobs.
- **Layout:** `videos/YYYY-MM-DD ShowName/` — date is **ingest/posting day (today)**, not original publish date. Library: gitignored `data/library.json`.
- **Stack:** bash + yt-dlp + ffmpeg · FastAPI `app/backend` · Vite/React `app/frontend` · STT local MLX only (no cloud key on happy path).
- **Whisper UI / API:** `small` (default) · `medium` only. Heavier sizes still work via CLI `transcribe.py` if needed.
- **Desk UI:** three columns — Sources+Clips rail · paper center · craft (monitor / clip trim / export). Fonts: Newsreader / Instrument Sans / IBM Plex Mono; terracotta accent.
- **Editor:** type Start/End + Enter/Apply → seek player + scroll transcript. Keys `I`/`O` set start/end at playhead. Click transcript line seeks.
- **Clip captions:** still scrub **source** video; **Generate captions** → clip-relative cues. Center **Captions** tab edits text; craft **Caption plate** = font/plate/position (app-wide localStorage). Monitor overlay matches burn-in. Export burns when cues exist + always writes `.srt`.
- **Pane tabs:** Transcript · Captions · Post · **Agent handoff** (optional). Flag `CLIPGENERATOR_AGENT_FLOW` default **0**; `./scripts/serve.sh` sets **1** for daily driver.
- **Packaging:** public `prompts/` = generic pipeline docs + clip-plan schema. Private editorial packs in **gitignored** `prompts/private/**`. App does not load packs at runtime — paste into external LLM.
- **Agent flow steps:** brief → Summary export → paste summary URL → Clip export → Import plan → Editor.
- **X gotcha:** some posts are **promo clips** (~30s); full episode may live on YouTube/Spotify/RSS — duration in UI is truth for what downloaded.
- **Never commit:** `.env`, `videos/`, `data/`, `.venv/`, `prompts/private/**` (except `README.md`), transcripts/audio sidecars.
- **UI rule:** tokens/classes in `app/frontend/src/styles/` only — no one-off colors/sizes.
- **Not built yet:** caption burn-in on export, full multi-clip publish board, post scheduling / auto-quote.

When unsure whether a path is public-safe, **ask the human** instead of committing.
