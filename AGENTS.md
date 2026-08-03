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

## Project context (for agents)

- **Name:** clipgenerator (git folder may still be the old name until renamed on GitHub).
- **Purpose:** Local CLI + localhost UI to download YouTube/X videos, transcribe with **MLX Whisper**, manage **many clips per source**, export H.264 clips.
- **Stack:** `yt-dlp`, `ffmpeg`, bash, `scripts/transcribe.py` (MLX Whisper), FastAPI (`app/backend`), Vite/React (`app/frontend`).
- **UI:** Use design tokens and component classes in `app/frontend/src/styles/` — see `app/frontend/DESIGN.md`. Do not invent one-off font sizes or colors.
- **Public:** Yes (intended). Local-only data lives in gitignored `.env`, `videos/`, `data/`.
- **Product decision:** Single monorepo for daily use + GitHub (no separate private fork).
- **STT:** Local only — no xAI dependency on the happy path.
- **Not yet:** caption burn-in, AI clip suggestions, post scheduling.

When unsure whether a path is public-safe, **ask the human** instead of committing.
