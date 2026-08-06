# Private workflow packs

**Not published** — everything under this directory except this README is gitignored.

## Layout

```text
prompts/private/
  README.md                 ← this file (tracked)
  <pack-name>/              ← your pack (local only)
    summary-instructions.md
    clipping-instructions.md
    playbook.md             ← optional
    memory-notes.md         ← optional
```

Example pack name: `vk-rollup`, `client-x`, etc.

## How to use

1. Put Grok (or other) **custom project instructions** in your pack folder so you have a local mirror.
2. Paste/update the same text into the corresponding LLM project UI.
3. Run clipgenerator with Agent flow on (`CLIPGENERATOR_AGENT_FLOW=1`).
4. Export packages from the app; drag into the LLM project; import clip-plan JSON back.

The app never requires a specific pack name. Packs are for **you**, not for the open-source runtime.

## Backup

If you use multiple machines, copy `prompts/private/` via encrypted backup, private git remote, or a private submodule — not the public `main` branch.
