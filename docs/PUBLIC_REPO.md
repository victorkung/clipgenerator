# Public repository policy

clipgenerator is maintained as **one public GitHub repository** that anyone can clone and run. Personal media, credentials, and brand-specific LLM packs stay **off `main`**.

Remote today: `https://github.com/victorkung/clipgenerator-public`

## Goals

1. **General-purpose tool** — install from README, run Editor workflow without any private files.
2. **Optional agent workflow** — public pipeline docs + schema only; your editorial instructions stay private.
3. **Safe by default** — gitignore and agent commit gates block the usual footguns.

## What belongs in the public repo

| Include | Examples |
|---------|----------|
| Application | `app/backend`, `app/frontend/src`, scripts, `requirements.txt` |
| Public docs | `README.md`, `CHANGELOG.md`, `docs/`, design system |
| Brand (product) | `brand/` logos, marks; `app/frontend/public/` favicons |
| Screenshots | `docs/images/*.png` (demo UI, no secrets) |
| Generic agent docs | `prompts/AGENT_PIPELINE.md`, schema example, `prompts/private/README.md` only |

## What must never be committed

| Path / pattern | Why |
|----------------|-----|
| `.env` | Local paths, keys, private config |
| `videos/` | Downloaded media, transcripts, exports |
| `data/` | Local library DB (`library.json`) |
| `prompts/private/**` except `README.md` | Brand/client editorial packs |
| `.venv/`, `node_modules/`, `app/frontend/dist/` | Environment noise |
| `*.audio.m4a`, `*.transcript.json`, `*.transcript.txt` | Derived private artifacts |
| Live API keys / cookies / session dumps | Credential leak |

`.gitignore` already covers the standard cases. Before every commit, agents follow the checklist in [AGENTS.md](../AGENTS.md).

## Single-repo vs split private packs

| Approach | When |
|----------|------|
| **Single public repo (recommended)** | Default. Personal packs live only under gitignored `prompts/private/` on your machine. |
| **Optional private sibling repo** | If you want packs backed up/synced across machines without a public leak — e.g. symlink `prompts/private/my-pack` → private repo. Not required to run the app. |

The app **does not load** private packs at runtime. You paste instructions into an external LLM.

## Contributor / maintainer checklist

Before push to `main`:

1. `git status` / `git diff` — no `videos/`, `data/`, `.env`, or private packs staged.
2. Scan for high-entropy secrets and personal absolute paths that shouldn’t be public (prefer placeholders in `.env.example`).
3. README / changelog still match behavior if flags or install steps changed.
4. Screenshots in `docs/images/` don’t show private credentials or unreleased client work you wouldn’t publish.
5. Do **not** `git add -A` blindly when ignored junk is present — stage explicit paths.

## Install surface for newcomers

Documented in the root [README.md](../README.md):

- Prerequisites (yt-dlp, ffmpeg, Python, Node, Apple Silicon for MLX)
- `pip install -r requirements.txt` (pulls `mlx-whisper`)
- First-run model download behavior
- Editor workflow vs Agent handoff
- `CLIPGENERATOR_AGENT_FLOW` flag

## License

If the repo has no `LICENSE` file yet, add one before marketing the project widely (MIT is a common default for tools like this). Without a license, others’ rights to use/modify are ambiguous under copyright law.
