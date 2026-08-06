# Optional agent pipeline

UI tabs: **Editor** (core product) · **Agent flow** (optional).

Enable with `CLIPGENERATOR_AGENT_FLOW=1` (see [README.md](./README.md)).

## Idea

clipgenerator owns media + transcript + timeline.  
An **external** LLM (your choice of tool/project) owns editorial judgment.

```text
Ingest → Agent flow:
  1) Export summary package (+ optional brief text)
  2) Publish summary on X; paste summary post URL
  3) Export clip package (quotes that summary)
  4) Refine in external agent; import lean JSON
→ Editor: trim, captions, encode
```

## Packages on disk

```text
videos/<source>/agent-export/
  summary/
    01-reference.md
    02-prompt.md
    03-transcript.md
    04-brief.md          # optional high-level brief you pasted
  clip/
    01-reference.md      # includes summary post URL
    02-prompt.md
    03-transcript.md
    clip-plan.imported.json   # last import (audit)
```

## Clip import JSON (lean, X-oriented)

See [CLIP_PLAN_SCHEMA.example.json](./CLIP_PLAN_SCHEMA.example.json).

Required per clip: `title`, times (`t_in`/`t_out` or labels), `post_text`.  
Optional: `tags`, `why`. No multi-platform caption fields required.

## Your instructions

Keep system prompts for Summary / Clipping agents in `prompts/private/` (gitignored) or in the LLM product only. This repo’s public surface stays pack-agnostic.
