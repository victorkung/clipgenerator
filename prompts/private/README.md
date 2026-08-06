# Private workflow packs

**Not published** — everything under this directory except this README is gitignored.

You do **not** need a separate private GitHub repo. Put packs here locally, or keep instructions only inside your LLM product (Grok projects, etc.).

## Layout

```text
prompts/private/
  README.md                 ← this file (tracked)
  <pack-name>/              ← your pack (local only, gitignored)
    summary-instructions.md
    clipping-instructions.md
    playbook.md             ← optional
    memory-notes.md         ← optional
```

## How to use

1. Store Grok (or other) **custom project instructions** in a pack folder as a local mirror — optional if they already live in the LLM UI.
2. Paste/update the same text into the corresponding LLM project when needed.
3. Run clipgenerator with Agent handoff on (`CLIPGENERATOR_AGENT_FLOW=1`, default via `serve.sh`).
4. Export packages from the app → drop into the LLM project → import clip-plan JSON back.

The app never requires a pack name and never reads these files at runtime.

## Backup

Use encrypted disk backup / Time Machine / copy the folder — not the public `main` branch.
