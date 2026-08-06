# Prompts & agent pipeline (public)

This folder holds **public, generic** assets for the optional **Agent flow** tab.

| File | Purpose |
|------|---------|
| [AGENT_PIPELINE.md](./AGENT_PIPELINE.md) | How the optional Summary → Clips → Import pipeline works |
| [CLIP_PLAN_SCHEMA.example.json](./CLIP_PLAN_SCHEMA.example.json) | Lean X-oriented JSON shape for clip import |

## Private packs (Option B)

Brand-specific Grok project instructions, playbooks, and memory live under:

```text
prompts/private/<your-pack>/
```

That tree is **gitignored** (except [private/README.md](./private/README.md)). Clone the public repo and drop your own pack in place—or keep a separate private repo/submodule.

clipgenerator does **not** load these files at runtime. You paste them into an external LLM (e.g. Grok web projects). The app only exports markdown packages + imports clip-plan JSON.

## Feature flag

| Env | Effect |
|-----|--------|
| `CLIPGENERATOR_AGENT_FLOW=0` | **Default** — Editor only (open-source happy path) |
| `CLIPGENERATOR_AGENT_FLOW=1` | Show **Agent flow** tab |

`./scripts/serve.sh` sets `CLIPGENERATOR_AGENT_FLOW=1` for local daily-driver use unless you override it.
