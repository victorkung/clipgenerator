import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { api, formatTs } from "./api";

const DEFAULT_STAGES = [
  { id: "queued", label: "Queued" },
  { id: "resolving", label: "Resolve" },
  { id: "downloading", label: "Download" },
  { id: "transcribing", label: "Transcribe" },
  { id: "done", label: "Ready" },
];

/** Daily-driver models only. Labels stay short; `guide` is the when-to-use hint. */
const WHISPER_MODELS = [
  {
    id: "small",
    label: "small · lightest",
    guide:
      "Default for any length. Fast daily driver (~5 min STT on a 1.5h English pod).",
  },
  {
    id: "medium",
    label: "medium · mid",
    guide:
      "Stronger than small. Prefer under ~45–60 min, or when small mangles names/jargon.",
  },
];

/** Soft threshold for “this might be a promo clip, not the full episode.” */
const SHORT_SOURCE_SECS = 90;

const LS_SUMMARY_PROMPT = "clipgenerator.agent.summaryPrompt";
const LS_CLIP_PROMPT = "clipgenerator.agent.clipPrompt";

/** Default summary-agent prompt (shared across all sources; editable). */
const DEFAULT_SUMMARY_PROMPT = `# Summary post generation

You are an external LLM agent. clipgenerator already transcribed the source video and packaged the files in this folder. Use them to draft a **summary post** for the episode.

## What to produce

1. A summary / recap post suitable for social (edit with the human until ready).
2. Optional short follow-up posts if the human asks.

Treat the transcript as the source of truth for quotes and accuracy.

## Files in this package

- \`01-reference.md\` — title, source URL, duration
- \`02-prompt.md\` — this prompt
- \`03-transcript.md\` — full timestamped transcript
`;

/** Default clip-agent prompt (shared across all sources; editable). */
const DEFAULT_CLIP_PROMPT = `# Clip plan generation

You are an external LLM agent. clipgenerator transcribed the source and packaged the files below so you can propose clip ranges and post text.

Use the **summary post URL** in \`01-reference.md\` as context (and as a quote target when relevant).

## What to produce

1. Shortlist candidate clips with in/out times (seconds or M:SS) and a one-line why.
2. After the human approves ranges, draft post text per clip.
3. Output **import JSON** that clipgenerator can load to create clips. Shape must match the clip plan schema — see the example linked in the app (**CLIP_PLAN_SCHEMA.example.json**).

Required per clip: \`title\`, \`t_in\`, \`t_out\`, \`post_text\`. Optional: \`tags\`, \`why\`.

That JSON is what populates the clip list in clipgenerator for trim, captions, and media export.

## Files in this package

- \`01-reference.md\` — source URL + summary post URL
- \`02-prompt.md\` — this prompt
- \`03-transcript.md\` — full timestamped transcript
`;

function loadSharedPrompt(key, fallback) {
  try {
    const v = localStorage.getItem(key);
    // Empty string is a valid saved value only if the key exists; prefer non-empty.
    if (v != null && v.trim()) return v;
  } catch {
    /* ignore */
  }
  return fallback;
}

/** Persist app-wide agent prompts on this browser only (never git). */
function saveSharedPrompt(key, value) {
  try {
    localStorage.setItem(key, value ?? "");
  } catch {
    /* private mode / quota — ignore */
  }
}

function hasStoredPrompt(key) {
  try {
    const v = localStorage.getItem(key);
    return v != null && v.trim().length > 0;
  } catch {
    return false;
  }
}

function stageIndex(stage, stages) {
  const ids = stages.map((s) => s.id);
  const map = {
    pending: "queued",
    queued: "queued",
    resolving: "resolving",
    downloading: "downloading",
    transcribing: "transcribing",
    done: "done",
    ready: "done",
    error: "error",
  };
  const id = map[stage] || stage;
  const i = ids.indexOf(id);
  return i < 0 ? 0 : i;
}

function statusWordClass(status) {
  if (status === "ready" || status === "rendered") return "status-word status-word--ready";
  if (status === "error") return "status-word status-word--error";
  if (["pending", "downloading", "transcribing", "queued"].includes(status)) {
    return "status-word status-word--progress";
  }
  if (status === "plan") return "status-word status-word--plan";
  return "status-word";
}

function formatDurationHuman(secs) {
  if (secs == null || !Number.isFinite(secs)) return "—";
  const s = Math.max(0, Math.round(secs));
  const m = Math.floor(s / 60);
  const r = s % 60;
  if (m <= 0) return `${r}s`;
  if (m < 60) return `${m} min ${r}`;
  const h = Math.floor(m / 60);
  return `${h}h ${m % 60}m`;
}

/** Shorten absolute export paths to `/clips/…` for the status panel. */
function shortExportPath(path) {
  if (!path) return path;
  const s = String(path);
  const i = s.lastIndexOf("/clips/");
  if (i >= 0) return s.slice(i);
  const j = s.lastIndexOf("clips/");
  if (j >= 0) return `/${s.slice(j)}`;
  return s;
}

/** Ensure @handles appear as the last line of post text (blank line above). */
function postWithHandles(postText, tags) {
  const handleLine = (tags || []).filter(Boolean).join(" ").trim();
  const body = postText || "";
  if (!handleLine) return body;
  const trimmed = body.replace(/\s+$/, "");
  if (trimmed.endsWith(handleLine)) return body;
  // Avoid duplicating if handles already appear at the end after whitespace
  const lines = trimmed.split("\n");
  const last = (lines[lines.length - 1] || "").trim();
  if (last === handleLine) return body;
  if (!trimmed) return handleLine;
  return `${trimmed}\n\n${handleLine}`;
}

function statusRank(status) {
  if (status === "ready") return 0;
  if (status === "error") return 2;
  if (["pending", "downloading", "transcribing", "queued"].includes(status)) return 1;
  return 3;
}

function CutMarkSvg() {
  return (
    <svg
      className="brand-mark__svg"
      viewBox="0 0 24 24"
      fill="none"
      xmlns="http://www.w3.org/2000/svg"
      aria-hidden
    >
      <path
        d="M7 5H4v14h3M17 5h3v14h-3"
        stroke="currentColor"
        strokeWidth="1.6"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
      <circle cx="12" cy="12" r="2" fill="currentColor" />
    </svg>
  );
}


function JobStatus({
  busy,
  message,
  title,
  percent,
  paths,
  onDismiss,
  onReveal,
  revealLabel = "Open in Finder",
  variant, // "success" | "error" | undefined (auto)
}) {
  const hasBody = !!(message || (paths || []).length || busy || title);
  if (!hasBody) return null;
  const tone =
    variant ||
    (busy ? "busy" : "done");
  return (
    <div
      className={`job-status job-status--${tone}`}
      role="status"
      aria-live="polite"
    >
      {onDismiss && !busy && (
        <button
          type="button"
          className="job-status__close"
          onClick={(e) => {
            e.preventDefault();
            e.stopPropagation();
            onDismiss();
          }}
          title="Dismiss"
          aria-label="Dismiss"
        >
          ×
        </button>
      )}
      {(title || busy) && (
        <div className="job-status__title">
          {busy && <span className="banner__spinner" />}
          <span>
            {busy
              ? message || "Working…"
              : title || (tone === "error" ? "Export failed" : "Export success")}
            {busy && percent != null && (
              <span className="banner__pct"> · {percent}%</span>
            )}
          </span>
        </div>
      )}
      {!busy && message && title && (
        <p className="job-status__detail">{message}</p>
      )}
      {!busy && message && !title && (
        <div className="job-status__row">
          <span className="job-status__text">{message}</span>
        </div>
      )}
      {!busy && paths?.length > 0 && (
        <div className="job-status__paths">
          {paths.map((p) => (
            <code key={p}>{p}</code>
          ))}
        </div>
      )}
      {busy && percent != null && (
        <div className="banner__track" aria-hidden>
          <div
            className="banner__fill"
            style={{ width: `${Math.min(100, Math.max(2, percent))}%` }}
          />
        </div>
      )}
      {!busy && onReveal && (
        <div className="job-status__footer">
          <button
            type="button"
            className="btn btn--sm btn--success"
            onClick={onReveal}
          >
            {revealLabel}
          </button>
        </div>
      )}
    </div>
  );
}

function PipelineProgress({ source }) {
  const job = source.job || {};
  const stages = job.stages || DEFAULT_STAGES;
  const stage = job.stage || source.status || "queued";
  const idx = stageIndex(stage, stages);
  const percent =
    typeof job.percent === "number"
      ? job.percent
      : Math.round((idx / Math.max(1, stages.length - 1)) * 100);
  const msg = job.message || source.status;
  const detail = job.detail;

  return (
    <div className="pipeline">
      <p className="pipeline__headline">
        {msg || "Working on this source…"}
        {typeof percent === "number" ? ` — ${percent}% of the way through.` : ""}
      </p>
      <div className="pipeline__track">
        <div
          className="pipeline__fill"
          style={{ width: `${Math.min(100, Math.max(2, percent))}%` }}
        />
      </div>
      <div className="pipeline__steps">
        {stages.map((st, i) => {
          let cls = "pipeline__step";
          if (stage === "error") cls += i <= idx ? " pipeline__step--error" : "";
          else if (i < idx) cls += " pipeline__step--done";
          else if (i === idx) cls += " pipeline__step--active";
          return (
            <div key={st.id} className={cls}>
              <div className="pipeline__dot" />
              <span>
                {st.label}
                {i < idx ? " ✓" : ""}
                {i === idx && typeof percent === "number" ? ` · ${percent}%` : ""}
              </span>
            </div>
          );
        })}
      </div>
      {detail && <p className="pipeline__detail">{detail}</p>}
      <p className="pipeline__detail">
        you can switch to a ready source and come back — the job keeps running · nothing
        uploads
      </p>
    </div>
  );
}

function isTypingTarget(el) {
  if (!el || !(el instanceof Element)) return false;
  const tag = el.tagName;
  if (tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT") return true;
  if (el.isContentEditable) return true;
  return !!el.closest("input, textarea, select, [contenteditable='true']");
}

export default function App() {
  const [sources, setSources] = useState([]);
  const [selectedId, setSelectedId] = useState(null);
  const [source, setSource] = useState(null);
  const [transcript, setTranscript] = useState(null);
  const [activeClipId, setActiveClipId] = useState(null);
  const [currentTime, setCurrentTime] = useState(0);
  const [url, setUrl] = useState("");
  const [model, setModel] = useState("small");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  const [exportMsg, setExportMsg] = useState(null);
  const [exportBusy, setExportBusy] = useState(false);
  const [exportPercent, setExportPercent] = useState(null);
  const [exportPath, setExportPath] = useState(null);
  const [exportStatusOpen, setExportStatusOpen] = useState(false);
  const [exportFailed, setExportFailed] = useState(false);
  const [captionsBusy, setCaptionsBusy] = useState(false);
  const [captionsMsg, setCaptionsMsg] = useState(null);
  const [agentBusy, setAgentBusy] = useState(false);
  const [agentMsg, setAgentMsg] = useState(null);
  const [agentMsgStep, setAgentMsgStep] = useState(null); // summary | clip | import
  const [planImportText, setPlanImportText] = useState("");
  const [planImportBusy, setPlanImportBusy] = useState(false);
  const [paneTab, setPaneTab] = useState("transcript"); // transcript | captions | post | agent
  const [agentFlowEnabled, setAgentFlowEnabled] = useState(true);
  const [inDraft, setInDraft] = useState("");
  const [outDraft, setOutDraft] = useState("");
  const [titleDraft, setTitleDraft] = useState("");
  const [editingTitle, setEditingTitle] = useState(false);
  const [summaryPromptDraft, setSummaryPromptDraft] = useState(() =>
    loadSharedPrompt(LS_SUMMARY_PROMPT, DEFAULT_SUMMARY_PROMPT)
  );
  const [clipPromptDraft, setClipPromptDraft] = useState(() =>
    loadSharedPrompt(LS_CLIP_PROMPT, DEFAULT_CLIP_PROMPT)
  );
  const [summaryUrlDraft, setSummaryUrlDraft] = useState("");
  const [importNotice, setImportNotice] = useState(null);
  const [retryBusy, setRetryBusy] = useState(false);
  const [copyFlash, setCopyFlash] = useState(null);
  const videoRef = useRef(null);
  const titleInputRef = useRef(null);
  const planFileRef = useRef(null);
  const selectedIdRef = useRef(selectedId);
  const exportOwnerIdRef = useRef(null);
  const copyTimerRef = useRef(null);
  const promptServerSyncRef = useRef(null);

  const refreshList = useCallback(async () => {
    const list = await api.listSources();
    setSources(list);
    return list;
  }, []);

  const loadSource = useCallback(
    async (id) => {
      if (!id) {
        setSource(null);
        setTranscript(null);
        return;
      }
      const s = await api.getSource(id);
      setSource(s);
      if (!editingTitle) setTitleDraft(s.title || "");
      // Agent prompts are app-wide (localStorage); do not reset per source
      setSummaryUrlDraft(s.summary_post_url || "");
      if (s.status === "ready" && s.transcript_json) {
        try {
          const t = await api.getTranscript(id);
          setTranscript(t);
        } catch {
          setTranscript(null);
        }
      } else {
        setTranscript(null);
      }
      const clips = s.clips || [];
      if (clips.length && !clips.find((c) => c.id === activeClipId)) {
        setActiveClipId(clips[0].id);
      }
    },
    [activeClipId, editingTitle]
  );

  // Keep agent prompts on this device: write localStorage on every edit (survives reload).
  useEffect(() => {
    saveSharedPrompt(LS_SUMMARY_PROMPT, summaryPromptDraft);
  }, [summaryPromptDraft]);

  useEffect(() => {
    saveSharedPrompt(LS_CLIP_PROMPT, clipPromptDraft);
  }, [clipPromptDraft]);

  // Debounced mirror onto the active source in gitignored data/library.json (for export packages).
  useEffect(() => {
    if (!source?.id) return;
    if (promptServerSyncRef.current) clearTimeout(promptServerSyncRef.current);
    promptServerSyncRef.current = setTimeout(() => {
      const sid = source.id;
      const sum = summaryPromptDraft;
      const clip = clipPromptDraft;
      api
        .updateSource(sid, {
          summary_prompt_text: sum,
          clip_prompt_text: clip,
        })
        .then((updated) => {
          setSource((prev) =>
            prev && prev.id === sid
              ? {
                  ...prev,
                  summary_prompt_text: updated.summary_prompt_text ?? sum,
                  clip_prompt_text: updated.clip_prompt_text ?? clip,
                }
              : prev
          );
        })
        .catch(() => {
          /* best-effort; localStorage is the source of truth for the UI */
        });
    }, 600);
    return () => {
      if (promptServerSyncRef.current) clearTimeout(promptServerSyncRef.current);
    };
  }, [summaryPromptDraft, clipPromptDraft, source?.id]);

  useEffect(() => {
    refreshList()
      .then((list) => {
        // Recover prompts from library if localStorage was cleared but library still has them.
        if (!hasStoredPrompt(LS_SUMMARY_PROMPT)) {
          const fromLib = (list || []).find(
            (s) => (s.summary_prompt_text || "").trim()
          );
          if (fromLib?.summary_prompt_text?.trim()) {
            setSummaryPromptDraft(fromLib.summary_prompt_text);
            saveSharedPrompt(LS_SUMMARY_PROMPT, fromLib.summary_prompt_text);
          }
        }
        if (!hasStoredPrompt(LS_CLIP_PROMPT)) {
          const fromLib = (list || []).find((s) => (s.clip_prompt_text || "").trim());
          if (fromLib?.clip_prompt_text?.trim()) {
            setClipPromptDraft(fromLib.clip_prompt_text);
            saveSharedPrompt(LS_CLIP_PROMPT, fromLib.clip_prompt_text);
          }
        }
      })
      .catch((e) => setError(String(e.message || e)));
  }, [refreshList]);

  useEffect(() => {
    api
      .health()
      .then((h) => {
        if (typeof h.agent_flow === "boolean") setAgentFlowEnabled(h.agent_flow);
      })
      .catch(() => {});
  }, []);

  // Retire turbo / large-v3 from the UI allowlist
  useEffect(() => {
    if (!WHISPER_MODELS.some((m) => m.id === model)) {
      setModel("small");
    }
  }, [model]);

  useEffect(() => {
    selectedIdRef.current = selectedId;
    setExportMsg(null);
    setExportPercent(null);
    setExportPath(null);
    setExportStatusOpen(false);
    setExportFailed(false);
    setCaptionsMsg(null);
    setAgentMsg(null);
    setAgentMsgStep(null);
    setImportNotice(null);
  }, [selectedId]);

  useEffect(() => {
    if (selectedId) loadSource(selectedId).catch((e) => setError(String(e.message || e)));
  }, [selectedId, loadSource]);

  useEffect(() => {
    if (!source || !["pending", "downloading", "transcribing"].includes(source.status)) {
      return undefined;
    }
    const t = setInterval(() => {
      loadSource(source.id).then(() => refreshList()).catch(() => {});
    }, 1500);
    return () => clearInterval(t);
  }, [source, loadSource, refreshList]);

  const activeClip = useMemo(
    () => (source?.clips || []).find((c) => c.id === activeClipId) || null,
    [source, activeClipId]
  );

  useEffect(() => {
    if (!activeClip) {
      setInDraft("");
      setOutDraft("");
      return;
    }
    setInDraft(formatTs(activeClip.t_in));
    setOutDraft(formatTs(activeClip.t_out));
  }, [activeClip?.id, activeClip?.t_in, activeClip?.t_out]);

  useEffect(() => {
    if (editingTitle && titleInputRef.current) titleInputRef.current.focus();
  }, [editingTitle]);

  // Append @handles as last line of post text when switching clips (if missing)
  useEffect(() => {
    if (!activeClip) return;
    const tags = activeClip.tags || [];
    if (!tags.length) return;
    const next = postWithHandles(activeClip.post_text || "", tags);
    if (next === (activeClip.post_text || "")) return;
    setSource((prev) => {
      if (!prev || !activeClipId) return prev;
      return {
        ...prev,
        clips: (prev.clips || []).map((c) =>
          c.id === activeClipId ? { ...c, post_text: next } : c
        ),
      };
    });
  }, [activeClipId]);

  const sortedSources = useMemo(() => {
    return [...sources].sort((a, b) => {
      const r = statusRank(a.status) - statusRank(b.status);
      if (r !== 0) return r;
      return String(b.updated_at || b.created_at || "").localeCompare(
        String(a.updated_at || a.created_at || "")
      );
    });
  }, [sources]);

  const segments = transcript?.segments || [];

  const activeSegIndex = useMemo(() => {
    if (!segments.length) return -1;
    const exact = segments.findIndex(
      (s) => currentTime >= s.start && currentTime < (s.end || s.start + 0.01)
    );
    if (exact >= 0) return exact;
    let best = -1;
    for (let i = 0; i < segments.length; i++) {
      if (segments[i].start <= currentTime) best = i;
      else break;
    }
    return best;
  }, [segments, currentTime]);

  useEffect(() => {
    if (activeSegIndex < 0) return;
    const el = document.getElementById(`seg-${activeSegIndex}`);
    if (el) el.scrollIntoView({ block: "nearest", behavior: "smooth" });
  }, [activeSegIndex]);

  async function onIngest(e) {
    e.preventDefault();
    setError(null);
    setExportMsg(null);
    if (!url.trim()) {
      setError("Paste a YouTube or X URL");
      return;
    }
    setBusy(true);
    try {
      const s = await api.ingest({ url: url.trim(), model });
      setSelectedId(s.id);
      setUrl("");
      await refreshList();
      await loadSource(s.id);
    } catch (err) {
      setError(String(err.message || err));
    } finally {
      setBusy(false);
    }
  }

  async function saveSourceTitle() {
    if (!source) return;
    const next = titleDraft.trim();
    if (!next) {
      setError("Title cannot be empty");
      setTitleDraft(source.title || "");
      setEditingTitle(false);
      return;
    }
    if (next === source.title) {
      setEditingTitle(false);
      return;
    }
    try {
      await api.updateSource(source.id, { title: next });
      setEditingTitle(false);
      await refreshList();
      await loadSource(source.id);
    } catch (err) {
      setError(String(err.message || err));
    }
  }

  async function deleteSource(id, title) {
    const label = title || "this source";
    if (
      !window.confirm(
        `Remove “${label}” from the sidebar?\n\nFiles on disk are kept (you can delete those in Finder).`
      )
    ) {
      return;
    }
    try {
      await api.deleteSource(id);
      if (selectedId === id) {
        setSelectedId(null);
        setSource(null);
        setTranscript(null);
        setActiveClipId(null);
      }
      await refreshList();
    } catch (err) {
      setError(String(err.message || err));
    }
  }

  async function retryTranscribe() {
    if (!source || retryBusy) return;
    setError(null);
    setRetryBusy(true);
    try {
      await api.retryTranscribe(source.id, model);
      await loadSource(source.id);
      await refreshList();
    } catch (err) {
      setError(String(err.message || err));
    } finally {
      setRetryBusy(false);
    }
  }

  async function saveClipPatch(patch) {
    if (!source || !activeClip) return;
    try {
      await api.updateClip(source.id, activeClip.id, patch);
      await loadSource(source.id);
      await refreshList();
    } catch (err) {
      setError(String(err.message || err));
    }
  }

  async function addClip() {
    if (!source) return;
    const t = videoRef.current?.currentTime ?? 0;
    try {
      const c = await api.createClip(source.id, {
        title: `Clip ${(source.clips?.length || 0) + 1}`,
        t_in: Math.max(0, t),
        t_out: Math.min(source.duration || t + 30, t + 30),
      });
      setActiveClipId(c.id);
      await loadSource(source.id);
    } catch (err) {
      setError(String(err.message || err));
    }
  }

  async function removeClip(clipId) {
    if (!source) return;
    try {
      await api.deleteClip(source.id, clipId);
      setActiveClipId(null);
      await loadSource(source.id);
    } catch (err) {
      setError(String(err.message || err));
    }
  }

  async function saveSummaryPrompt() {
    // Immediate flush (blur / export) — localStorage already updated via effect.
    saveSharedPrompt(LS_SUMMARY_PROMPT, summaryPromptDraft);
    if (!source) return;
    try {
      const updated = await api.updateSource(source.id, {
        summary_prompt_text: summaryPromptDraft,
      });
      setSource((prev) => ({ ...prev, ...updated }));
    } catch (err) {
      setError(String(err.message || err));
    }
  }

  async function saveClipPrompt() {
    saveSharedPrompt(LS_CLIP_PROMPT, clipPromptDraft);
    if (!source) return;
    try {
      const updated = await api.updateSource(source.id, {
        clip_prompt_text: clipPromptDraft,
      });
      setSource((prev) => ({ ...prev, ...updated }));
    } catch (err) {
      setError(String(err.message || err));
    }
  }

  async function saveSummaryUrl() {
    if (!source) return;
    try {
      const updated = await api.updateSource(source.id, {
        summary_post_url: summaryUrlDraft.trim(),
      });
      setSource((prev) => ({ ...prev, ...updated }));
      setSummaryUrlDraft(updated.summary_post_url || summaryUrlDraft.trim());
    } catch (err) {
      setError(String(err.message || err));
    }
  }

  async function exportSummaryPackage() {
    if (!source || agentBusy) return;
    setError(null);
    setAgentBusy(true);
    setAgentMsgStep("summary");
    setAgentMsg("Exporting summary package…");
    try {
      if (summaryPromptDraft !== (source.summary_prompt_text || "")) {
        await saveSummaryPrompt();
      }
      const result = await api.exportSummaryPackage(source.id);
      setAgentMsg(
        `Summary package ready\n${result.dir}\nDrag into your Summary LLM project.`
      );
      try {
        await api.revealPath(result.dir);
      } catch {
        /* best-effort */
      }
    } catch (err) {
      setError(String(err.message || err));
      setAgentMsg(null);
      setAgentMsgStep(null);
    } finally {
      setAgentBusy(false);
    }
  }

  async function exportClipPackage() {
    if (!source || agentBusy) return;
    setError(null);
    setAgentBusy(true);
    setAgentMsgStep("clip");
    setAgentMsg("Exporting clip package…");
    try {
      if (summaryUrlDraft.trim() !== (source.summary_post_url || "")) {
        await saveSummaryUrl();
      }
      if (clipPromptDraft !== (source.clip_prompt_text || "")) {
        await saveClipPrompt();
      }
      if (!summaryUrlDraft.trim() && !(source.summary_post_url || "").trim()) {
        setError("Paste the summary post URL before exporting the clip package");
        setAgentBusy(false);
        setAgentMsg(null);
        setAgentMsgStep(null);
        return;
      }
      const result = await api.exportClipPackage(source.id);
      setAgentMsg(
        `Clip package ready\n${result.dir}\nDrag into your Clipping LLM project.`
      );
      try {
        await api.revealPath(result.dir);
      } catch {
        /* best-effort */
      }
    } catch (err) {
      setError(String(err.message || err));
      setAgentMsg(null);
      setAgentMsgStep(null);
    } finally {
      setAgentBusy(false);
    }
  }

  async function importClipPlan() {
    if (!source || planImportBusy) return;
    const text = planImportText.trim();
    if (!text) {
      setError("Paste the clip-plan JSON (or choose a .json file) first");
      return;
    }
    setError(null);
    setPlanImportBusy(true);
    setAgentMsgStep("import");
    setAgentMsg("Importing clip plan…");
    try {
      let body = { text };
      try {
        body = { plan: JSON.parse(text) };
      } catch {
        body = { text };
      }
      const result = await api.importClipPlan(source.id, body);
      setPlanImportText("");
      await loadSource(source.id);
      await refreshList();
      const n = result.created || 0;
      const errN = (result.errors || []).length;
      const lines = (result.summary || result.clips || [])
        .map((c) => {
          const a = formatTs(c.t_in);
          const b = formatTs(c.t_out);
          return `· ${c.title || "clip"}  ${a}–${b}`;
        })
        .join("\n");
      const notice =
        `Imported ${n} clip(s) from plan` +
        (lines ? `\n${lines}` : "") +
        (errN ? `\n(${errN} skipped: ${(result.errors || []).join("; ")})` : "") +
        "\nRefine times, captions, and export in the Editor.";
      setAgentMsg(null);
      setAgentMsgStep(null);
      setImportNotice(notice);
      if (result.clips?.[0]?.id) {
        setActiveClipId(result.clips[0].id);
        const tin = result.clips[0].t_in;
        if (typeof tin === "number") seekTo(tin);
      }
      setPaneTab("transcript");
    } catch (err) {
      setError(String(err.message || err));
      setAgentMsg(null);
      setAgentMsgStep(null);
    } finally {
      setPlanImportBusy(false);
    }
  }

  function onPlanFileChosen(e) {
    const file = e.target.files?.[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = () => {
      setPlanImportText(String(reader.result || ""));
    };
    reader.onerror = () => setError("Could not read file");
    reader.readAsText(file);
    e.target.value = "";
  }

  async function generateCaptions() {
    if (!source || !activeClip || captionsBusy) return;
    setError(null);
    setCaptionsBusy(true);
    setCaptionsMsg(null);
    try {
      const updated = await api.generateCaptions(source.id, activeClip.id);
      setSource((prev) => ({
        ...prev,
        clips: (prev.clips || []).map((c) =>
          c.id === updated.id ? { ...c, ...updated } : c
        ),
      }));
      setPaneTab("captions");
      setCaptionsMsg(
        `Captions ready — ${updated.captions?.length || 0} line(s) (times relative to clip start)`
      );
      await refreshList();
    } catch (err) {
      setError(String(err.message || err));
    } finally {
      setCaptionsBusy(false);
    }
  }

  function patchCaptionLocal(capId, patch) {
    if (!activeClipId) return;
    setSource((prev) => ({
      ...prev,
      clips: (prev.clips || []).map((c) => {
        if (c.id !== activeClipId) return c;
        return {
          ...c,
          captions: (c.captions || []).map((cap) =>
            cap.id === capId ? { ...cap, ...patch } : cap
          ),
        };
      }),
    }));
  }

  async function persistCaptions() {
    if (!source || !activeClip) return;
    try {
      const updated = await api.saveCaptions(
        source.id,
        activeClip.id,
        activeClip.captions || []
      );
      setSource((prev) => ({
        ...prev,
        clips: (prev.clips || []).map((c) =>
          c.id === updated.id ? { ...c, ...updated } : c
        ),
      }));
    } catch (err) {
      setError(String(err.message || err));
    }
  }

  async function removeCaptionAndSave(capId) {
    if (!source || !activeClip) return;
    const next = (activeClip.captions || []).filter((c) => c.id !== capId);
    try {
      const updated = await api.saveCaptions(source.id, activeClip.id, next);
      setSource((prev) => ({
        ...prev,
        clips: (prev.clips || []).map((c) =>
          c.id === updated.id ? { ...c, ...updated } : c
        ),
      }));
    } catch (err) {
      setError(String(err.message || err));
    }
  }

  async function runExportJob(clipIds, label) {
    if (!source || exportBusy) return;
    const ownerId = source.id;
    exportOwnerIdRef.current = ownerId;
    const onOwner = () => selectedIdRef.current === ownerId;

    setError(null);
    setExportBusy(true);
    setExportPercent(0);
    setExportPath(null);
    setExportFailed(false);
    setExportStatusOpen(true);
    setExportMsg(label || "Starting export…");
    try {
      const started = await api.exportClips(ownerId, clipIds);
      const jobId = started.job_id;
      if (!jobId) throw new Error("export did not return a job id");

      let job;
      for (;;) {
        await new Promise((r) => setTimeout(r, 400));
        job = await api.getExportJob(jobId);
        if (onOwner()) {
          if (typeof job.percent === "number") setExportPercent(job.percent);
          if (job.message) setExportMsg(job.message);
        }
        if (job.status === "done" || job.status === "error") break;
      }

      const n = job.exported?.length || 0;
      if (job.status === "error" && !n) {
        if (onOwner()) {
          setExportFailed(true);
          setExportStatusOpen(true);
          setExportMsg(
            (job.errors || [job.message || "export failed"]).join("; ")
          );
          setExportPercent(null);
          setExportPath(null);
        }
      } else if (onOwner()) {
        setExportFailed(false);
        setExportStatusOpen(true);
        setExportPercent(100);
        const out = job.out_dir || null;
        setExportPath(out);
        const failNote = job.errors?.length
          ? ` (${job.errors.length} failed)`
          : "";
        setExportMsg(
          n === 1
            ? `Cut and encoded.${failNote}`
            : `Cut and encoded ${n} clips.${failNote}`
        );
      }
      if (onOwner()) await loadSource(ownerId);
      await refreshList();
    } catch (err) {
      if (onOwner()) {
        setExportFailed(true);
        setExportStatusOpen(true);
        setExportMsg(String(err.message || err));
        setExportPercent(null);
        setExportPath(null);
      }
    } finally {
      if (exportOwnerIdRef.current === ownerId) exportOwnerIdRef.current = null;
      setExportBusy(false);
    }
  }

  async function exportOne() {
    if (!source || !activeClip || exportBusy) return;
    await runExportJob(
      [activeClip.id],
      `Exporting “${activeClip.title || "clip"}”…`
    );
  }

  async function exportAll() {
    if (!source || exportBusy) return;
    const n = source.clips?.length || 0;
    await runExportJob(null, `Exporting all ${n} clip(s)…`);
  }

  async function revealExport() {
    const path =
      exportPath ||
      activeClip?.export_path ||
      null;
    if (!path) return;
    try {
      await api.revealPath(path);
    } catch (err) {
      setError(String(err.message || err));
    }
  }

  function parseTsInput(str) {
    const s = (str || "").trim();
    if (!s) return null;
    if (/^\d+(\.\d+)?$/.test(s)) return parseFloat(s);
    const parts = s.split(":").map((p) => parseFloat(p));
    if (parts.some((n) => Number.isNaN(n))) return null;
    if (parts.length === 3) return parts[0] * 3600 + parts[1] * 60 + parts[2];
    if (parts.length === 2) return parts[0] * 60 + parts[1];
    return null;
  }

  function setInFromPlayhead() {
    if (!activeClip || !videoRef.current) return;
    const t = videoRef.current.currentTime;
    const t_out = Math.max(activeClip.t_out, t + 0.5);
    saveClipPatch({ t_in: t, t_out });
  }

  function setOutFromPlayhead() {
    if (!activeClip || !videoRef.current) return;
    const t = videoRef.current.currentTime;
    let t_in = activeClip.t_in;
    if (t <= t_in) t_in = Math.max(0, t - 0.5);
    saveClipPatch({ t_in, t_out: t });
  }

  /**
   * Apply typed Start/End. Seeks the player (and thus transcript highlight/scroll)
   * so typing a time immediately shows that moment.
   * @param {{ seek?: "in" | "out" }} [opts]
   */
  function applyTypedTimes(opts = {}) {
    if (!activeClip) return;
    const seekField = opts.seek === "out" ? "out" : "in";
    let t_in = parseTsInput(inDraft);
    let t_out = parseTsInput(outDraft);
    if (t_in == null || t_out == null) {
      setError("Use times like 1:23 or 1:02:03");
      return;
    }

    const dur =
      typeof source?.duration === "number" && source.duration > 0
        ? source.duration
        : null;
    if (dur != null) {
      t_in = Math.max(0, Math.min(t_in, Math.max(0, dur - 0.5)));
      t_out = Math.max(0, Math.min(t_out, dur));
    } else {
      t_in = Math.max(0, t_in);
      t_out = Math.max(0, t_out);
    }

    if (t_out <= t_in) {
      const prevDur = Math.max(0.5, (activeClip.t_out || 0) - (activeClip.t_in || 0));
      if (seekField === "out") {
        t_in = Math.max(0, t_out - prevDur);
      } else {
        t_out = t_in + prevDur;
        if (dur != null) t_out = Math.min(t_out, dur);
        if (t_out <= t_in) t_out = Math.min(dur ?? t_in + 0.5, t_in + 0.5);
      }
    }

    setError(null);
    const seekT = seekField === "out" ? Math.max(t_in, t_out - 0.25) : t_in;
    seekTo(seekT);
    saveClipPatch({ t_in, t_out });
  }

  function seekTo(t) {
    if (videoRef.current) {
      const dur = videoRef.current.duration;
      let next = Math.max(0, t);
      if (Number.isFinite(dur) && dur > 0) {
        next = Math.min(next, Math.max(0, dur - 0.05));
      }
      videoRef.current.currentTime = next;
      setCurrentTime(next);
    }
  }

  function onSegClick(seg, e) {
    if (e.shiftKey && activeClip) {
      const t_out = Math.max(seg.end || seg.start + 1, seg.start + 0.5);
      let t_in = activeClip.t_in;
      if (t_in >= t_out) t_in = Math.max(0, seg.start);
      saveClipPatch({ t_in, t_out });
      return;
    }
    if (e.altKey && activeClip) {
      const t_in = seg.start;
      const t_out = Math.max(activeClip.t_out, t_in + 0.5);
      saveClipPatch({ t_in, t_out });
      seekTo(t_in);
      return;
    }
    seekTo(seg.start);
  }

  function flashCopy(key) {
    setCopyFlash(key);
    if (copyTimerRef.current) clearTimeout(copyTimerRef.current);
    copyTimerRef.current = setTimeout(() => setCopyFlash(null), 1500);
  }

  async function copyText(text, key) {
    if (!text) return;
    try {
      await navigator.clipboard?.writeText(text);
      flashCopy(key);
    } catch {
      setError("Could not copy to clipboard");
    }
  }

  // I / O keyboard marks (skip when typing in fields)
  const markKeysOk =
    !!activeClip &&
    source?.status === "ready" &&
    paneTab !== "agent"; // I/O still work from post/captions while craft is visible

  useEffect(() => {
    if (!markKeysOk) return undefined;
    function onKey(e) {
      if (e.metaKey || e.ctrlKey || e.altKey) return;
      if (isTypingTarget(e.target)) return;
      const k = e.key.toLowerCase();
      if (k === "i") {
        e.preventDefault();
        setInFromPlayhead();
      } else if (k === "o") {
        e.preventDefault();
        setOutFromPlayhead();
      }
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [markKeysOk, activeClip, source]);

  const mediaSrc =
    source?.video_path && source.status === "ready"
      ? api.mediaUrl(source.video_path)
      : null;

  const inRange =
    activeClip &&
    currentTime >= activeClip.t_in &&
    currentTime <= activeClip.t_out;

  const sourceDuration =
    typeof source?.duration === "number" && source.duration > 0
      ? source.duration
      : 0;

  const clipCaptions = activeClip?.captions || [];
  const captionsMeta = activeClip?.captions_meta;
  const captionsStale =
    !!captionsMeta &&
    activeClip &&
    (Math.abs(Number(captionsMeta.t_in) - Number(activeClip.t_in)) > 0.05 ||
      Math.abs(Number(captionsMeta.t_out) - Number(activeClip.t_out)) > 0.05);

  const clipRelTime =
    activeClip != null ? Math.max(0, currentTime - activeClip.t_in) : 0;

  const activeCaption = useMemo(() => {
    if (!activeClip || !clipCaptions.length || !inRange) return null;
    return (
      clipCaptions.find(
        (c) =>
          clipRelTime >= Number(c.start) &&
          clipRelTime < Number(c.end || c.start + 0.01)
      ) || null
    );
  }, [activeClip, clipCaptions, clipRelTime, inRange]);

  const summaryUrlDone = !!(summaryUrlDraft.trim() || source?.summary_post_url);
  const planDone = !!(source?.clips || []).some((c) => c.from_plan);
  const canRetryTranscribe =
    source &&
    source.status === "error" &&
    source.video_path &&
    !retryBusy;
  const isShortSource =
    source &&
    typeof source.duration === "number" &&
    source.duration > 0 &&
    source.duration < SHORT_SOURCE_SECS;
  const postCharCount = (activeClip?.post_text || "").length;
  const hasPostContent = !!(
    activeClip?.post_text ||
    activeClip?.why ||
    (activeClip?.tags || []).length
  );

  const agentStepsDone =
    (summaryUrlDone || planDone ? 1 : 0) +
    (summaryUrlDone ? 1 : 0) +
    (planDone ? 1 : 0);
  const clipCount = (source?.clips || []).length;
  const showWhyOnCards = clipCount < 10;

  function goHome() {
    setSelectedId(null);
    setSource(null);
    setTranscript(null);
    setActiveClipId(null);
    setEditingTitle(false);
    setPaneTab("transcript");
    setError(null);
    setImportNotice(null);
  }

  const exportPaths = useMemo(() => {
    const paths = [];
    if (activeClip?.export_path) paths.push(shortExportPath(activeClip.export_path));
    if (activeClip?.captions_srt) paths.push(shortExportPath(activeClip.captions_srt));
    if (
      exportPath &&
      !paths.some(
        (p) =>
          p.includes(shortExportPath(exportPath)) ||
          shortExportPath(exportPath).includes(p)
      )
    ) {
      paths.push(shortExportPath(exportPath));
    }
    return paths;
  }, [activeClip?.export_path, activeClip?.captions_srt, exportPath]);

  return (
    <div className="app">
      <header className="top">
        <button
          type="button"
          className="brand"
          onClick={goHome}
          title="Back to welcome"
        >
          <div className="brand-mark" aria-hidden>
            <CutMarkSvg />
          </div>
          <div className="brand__text">
            <span className="brand__name">clipgenerator</span>
            <span className="brand__tag">a local clip desk</span>
          </div>
        </button>
        <form className="ingest" onSubmit={onIngest}>
          <div className="ingest__row">
            <input
              className="input"
              type="url"
              value={url}
              onChange={(e) => setUrl(e.target.value)}
              placeholder="Paste a YouTube or X link"
              disabled={busy}
              autoFocus={!source}
            />
            <select
              className="select"
              value={model}
              onChange={(e) => setModel(e.target.value)}
              disabled={busy}
              title={WHISPER_MODELS.find((m) => m.id === model)?.guide || ""}
            >
              {WHISPER_MODELS.map((m) => (
                <option key={m.id} value={m.id}>
                  {m.id}
                </option>
              ))}
            </select>
            <button
              type="submit"
              className="btn btn--primary"
              disabled={busy}
            >
              {busy ? "Adding…" : "Add source"}
            </button>
          </div>
        </form>
      </header>

      {error && (
        <div className="banner banner--error" onClick={() => setError(null)}>
          <span className="banner__text">{error}</span>
          <span className="banner__dismiss">Dismiss</span>
        </div>
      )}

      <div className="layout">
        <aside className="sidebar">
          <div className="sidebar__sources">
            <div className="section-label">
              <h2 className="section-label__title">Sources</h2>
              <span className="section-label__count">{sources.length}</span>
            </div>
            <ul className="sidebar__list">
              {sortedSources.map((s) => (
                <li
                  key={s.id}
                  className={`list-item ${s.id === selectedId ? "list-item--active" : ""}`}
                  onClick={() => {
                    setEditingTitle(false);
                    setSelectedId(s.id);
                  }}
                >
                  <div className="list-item__row">
                    <div className="list-item__title list-item__title--clamp">
                      {s.title || s.id}
                    </div>
                  </div>
                  <div className="list-item__meta">
                    {s.duration != null && (
                      <span className="text-mono">{formatTs(s.duration)}</span>
                    )}
                    {s.duration != null && s.model && <span className="sep">·</span>}
                    {s.model && <span>{s.model}</span>}
                    {(s.duration != null || s.model) && <span className="sep">·</span>}
                    <span>
                      {(s.clips || []).length} clip
                      {(s.clips || []).length === 1 ? "" : "s"}
                    </span>
                    <span className="sep">·</span>
                    <span className={statusWordClass(s.status)}>
                      {s.status === "transcribing" && s.job?.percent != null
                        ? `transcribing ${s.job.percent}%`
                        : s.status}
                    </span>
                    <button
                      type="button"
                      className="btn btn--icon btn--danger list-item__remove"
                      title="Remove from sidebar"
                      onClick={(e) => {
                        e.stopPropagation();
                        deleteSource(s.id, s.title);
                      }}
                    >
                      ×
                    </button>
                  </div>
                </li>
              ))}
              {!sources.length && (
                <li className="sidebar__empty">
                  No sources yet.
                  <br />
                  Paste a link above.
                </li>
              )}
            </ul>
          </div>

          <div className="sidebar__divider" />

          <div className="sidebar__clips">
            <div className="section-label">
              <h2 className="section-label__title">
                Clips{!source ? " —" : ""}
              </h2>
            </div>
            {source?.status === "ready" ? (
              <>
                <ul className="sidebar__clips-list">
                  {(source.clips || []).map((c) => {
                    const st =
                      c.from_plan && c.status === "draft" ? "plan" : c.status;
                    return (
                      <li key={c.id}>
                        <div
                          className={`clip-card ${
                            c.id === activeClipId ? "clip-card--active" : ""
                          }`}
                          onClick={() => {
                            setActiveClipId(c.id);
                            seekTo(c.t_in);
                          }}
                          role="button"
                          tabIndex={0}
                          onKeyDown={(e) => {
                            if (e.key === "Enter" || e.key === " ") {
                              e.preventDefault();
                              setActiveClipId(c.id);
                              seekTo(c.t_in);
                            }
                          }}
                        >
                          <div className="clip-card__top">
                            <span className="clip-card__title">{c.title}</span>
                            <span className={statusWordClass(st)}>{st}</span>
                          </div>
                          <div className="clip-card__range">
                            {formatTs(c.t_in)} – {formatTs(c.t_out)} ·{" "}
                            {Math.max(0, (c.t_out || 0) - (c.t_in || 0)).toFixed(
                              1
                            )}
                            s
                          </div>
                          {showWhyOnCards && c.why && (
                            <p className="clip-card__why">why · {c.why}</p>
                          )}
                          <button
                            type="button"
                            className="btn btn--icon btn--danger"
                            title="Delete clip"
                            onClick={(e) => {
                              e.stopPropagation();
                              removeClip(c.id);
                            }}
                          >
                            ×
                          </button>
                        </div>
                      </li>
                    );
                  })}
                  {!(source.clips || []).length && (
                    <li className="sidebar__empty sidebar__empty--dim">
                      No clips yet — mark a range or import a plan.
                    </li>
                  )}
                </ul>
                <button
                  type="button"
                  className="btn sidebar__add-clip"
                  onClick={addClip}
                  disabled={exportBusy}
                >
                  Add clip
                </button>
              </>
            ) : (
              <p className="sidebar__empty sidebar__empty--dim">
                {source
                  ? "Clips appear once the transcript is ready."
                  : "Select a source to see clips."}
              </p>
            )}
          </div>

          <div className="sidebar__foot">
            {source?.folder || source?.video_path ? (
              <button
                type="button"
                className="sidebar__foot-action"
                title={source.folder || source.video_path}
                onClick={() =>
                  api
                    .revealPath(source.folder || source.video_path)
                    .catch((e) => setError(String(e.message || e)))
                }
              >
                Open in Finder
              </button>
            ) : (
              <span className="sidebar__foot-muted">library · data/library.json</span>
            )}
          </div>
        </aside>

        <section className={`center-col ${!source ? "center-col--empty" : ""}`}>
          {!source && (
            <div className="empty-layout">
              <div className="paper empty-paper">
                <p className="empty-paper__label">Welcome</p>
                <h1 className="empty-paper__headline">
                  Paste a link and it becomes a transcript you can cut clips from.
                </h1>
                <p className="empty-paper__body">
                  Download and transcription both happen on this machine — no
                  account, no upload, no speech bill. Expect a few minutes on an
                  hour-long show, then the episode reads like a document.
                </p>
                <ol className="empty-paper__steps">
                  <li>
                    <strong>01</strong>
                    <span>
                      <strong>Ingest</strong> — yt-dlp downloads the video, Whisper
                      transcribes it locally.
                    </span>
                  </li>
                  <li>
                    <strong>02</strong>
                    <span>
                      <strong>Mark</strong> — press <strong>I</strong> /{" "}
                      <strong>O</strong> at the playhead, or type start/end times.
                      Many clips per source.
                    </span>
                  </li>
                  <li>
                    <strong>03</strong>
                    <span>
                      <strong>Caption, write the post, export</strong> — H.264 + AAC
                      into clips/, with an SRT beside it.
                    </span>
                  </li>
                </ol>
              </div>
            </div>
          )}

          {source && (
            <>
              <div className="source-head">
                <div className="source-head__block">
                  {editingTitle ? (
                    <input
                      ref={titleInputRef}
                      className="input input--title"
                      value={titleDraft}
                      onChange={(e) => setTitleDraft(e.target.value)}
                      onBlur={saveSourceTitle}
                      onKeyDown={(e) => {
                        if (e.key === "Enter") saveSourceTitle();
                        if (e.key === "Escape") {
                          setTitleDraft(source.title || "");
                          setEditingTitle(false);
                        }
                      }}
                    />
                  ) : (
                    <h1
                      className="text-title source-head__title"
                      title="Click to rename"
                      onClick={() => {
                        setTitleDraft(source.title || "");
                        setEditingTitle(true);
                      }}
                    >
                      {source.title}
                      <span className="edit-hint">rename</span>
                    </h1>
                  )}
                  <p className="source-head__sub">
                    {source.duration != null && (
                      <span>{formatTs(source.duration)}</span>
                    )}
                    {source.model && (
                      <>
                        <span className="sep">·</span>
                        <span>{source.model}</span>
                      </>
                    )}
                    <span className="sep">·</span>
                    <span className={statusWordClass(source.status)}>
                      {source.status}
                    </span>
                    <span className="sep">·</span>
                    <button
                      type="button"
                      className="linkish"
                      onClick={() => {
                        setTitleDraft(source.title || "");
                        setEditingTitle(true);
                      }}
                    >
                      rename
                    </button>
                    <span className="sep">·</span>
                    <button
                      type="button"
                      className="linkish"
                      onClick={() => deleteSource(source.id, source.title)}
                    >
                      remove
                    </button>
                  </p>
                  {source.error && source.status !== "error" && (
                    <p className="error-text">{source.error}</p>
                  )}
                </div>
              </div>

              {isShortSource && source.status === "ready" && (
                <div className="source-alert source-alert--warning" role="status">
                  <p className="source-alert__title">
                    This one is {formatTs(source.duration)} long — an X promo, not
                    the episode.
                  </p>
                  <p className="source-alert__detail">
                    Full episodes often live on YouTube or the podcast feed. Duration
                    in the UI is truth for what downloaded.
                  </p>
                </div>
              )}

              {source.status === "error" && (
                <div className="source-alert source-alert--error">
                  <p className="source-alert__title">
                    {source.error || "Something failed on this source."}
                  </p>
                  {canRetryTranscribe && (
                    <div className="source-alert__actions">
                      <button
                        type="button"
                        className="btn btn--primary btn--sm"
                        onClick={retryTranscribe}
                        disabled={retryBusy}
                      >
                        {retryBusy ? "Retrying…" : "Retry transcribe"}
                      </button>
                      <select
                        className="select"
                        value={model}
                        onChange={(e) => setModel(e.target.value)}
                        disabled={retryBusy}
                        style={{ width: "auto" }}
                      >
                        {WHISPER_MODELS.map((m) => (
                          <option key={m.id} value={m.id}>
                            {m.id}
                          </option>
                        ))}
                      </select>
                      <span className="text-meta">
                        the video on disk is reused — nothing re-downloads
                      </span>
                    </div>
                  )}
                </div>
              )}

              {source.status !== "ready" && source.status !== "error" && (
                <PipelineProgress source={source} />
              )}

              {importNotice && paneTab !== "agent" && (
                <div
                  className="import-notice"
                  role="status"
                  onClick={() => setImportNotice(null)}
                >
                  {importNotice}
                  <span className="banner__dismiss"> · Dismiss</span>
                </div>
              )}

              {source.status === "ready" && (
                <>
                  <div className="pane-tabs" role="tablist" aria-label="Center panes">
                    <button
                      type="button"
                      role="tab"
                      aria-selected={paneTab === "transcript"}
                      className={`pane-tab ${
                        paneTab === "transcript" ? "pane-tab--active" : ""
                      }`}
                      onClick={() => setPaneTab("transcript")}
                    >
                      Transcript
                    </button>
                    <button
                      type="button"
                      role="tab"
                      aria-selected={paneTab === "captions"}
                      className={`pane-tab ${
                        paneTab === "captions" ? "pane-tab--active" : ""
                      }`}
                      onClick={() => setPaneTab("captions")}
                    >
                      Captions
                    </button>
                    <button
                      type="button"
                      role="tab"
                      aria-selected={paneTab === "post"}
                      className={`pane-tab ${
                        paneTab === "post" ? "pane-tab--active" : ""
                      }`}
                      onClick={() => setPaneTab("post")}
                    >
                      Post
                    </button>
                    {agentFlowEnabled && (
                      <button
                        type="button"
                        role="tab"
                        aria-selected={paneTab === "agent"}
                        className={`pane-tab pane-tab--agent ${
                          paneTab === "agent" ? "pane-tab--active" : ""
                        }`}
                        onClick={() => setPaneTab("agent")}
                      >
                        Agent handoff
                      </button>
                    )}
                  </div>

                  <div className="center-scroll">
                    {paneTab === "agent" && agentFlowEnabled ? (
                      <div className="paper paper--agent">
                        <div className="paper__body agent-flow">
                        <p className="agent-flow__intro">
                          clipgenerator owns download, local transcription, clip
                          marks, captions, and export. It does <strong>not</strong>{" "}
                          call an LLM. Recommended workflow: export a file package
                          from here → paste or drop those files into your own
                          text-based agent (Grok, ChatGPT, Claude, etc.) with your
                          editorial instructions → bring a clip plan JSON back into
                          step 3. Judgment and model choice stay outside this app.
                        </p>

                        <section className="agent-step">
                          <div className="agent-step__head">
                            <div>
                              <h2 className="agent-step__title">
                                1 · Summary post generation
                              </h2>
                              <p className="agent-step__meta">
                                agent-export/summary/ · reference + prompt + transcript
                              </p>
                            </div>
                          </div>
                          <p className="agent-flow__step-copy">
                            After the video is transcribed, export a folder of files
                            you can hand to an external agent that drafts a{" "}
                            <strong>summary post</strong>. Package includes{" "}
                            <code>01-reference.md</code> (title, source URL),{" "}
                            <code>02-prompt.md</code> (editable below), and{" "}
                            <code>03-transcript.md</code> (full timestamped transcript).
                          </p>
                          <label className="field">
                            <span className="field__label">
                              Summary agent prompt{" "}
                              <span className="text-meta">
                                (saved on this device · written to 02-prompt.md)
                              </span>
                            </span>
                            <textarea
                              className="input agent-brief-panel__textarea"
                              rows={10}
                              value={summaryPromptDraft}
                              onChange={(e) => setSummaryPromptDraft(e.target.value)}
                              onBlur={saveSummaryPrompt}
                              spellCheck={false}
                            />
                          </label>
                          <div className="clip-bar__row">
                            <button
                              type="button"
                              className="btn btn--primary"
                              onClick={exportSummaryPackage}
                              disabled={agentBusy}
                            >
                              {agentBusy && agentMsgStep === "summary"
                                ? "Exporting…"
                                : "Export summary package"}
                            </button>
                            <button
                              type="button"
                              className="btn btn--paper"
                              onClick={() =>
                                api
                                  .revealPath(
                                    (source.folder || "") + "/agent-export/summary"
                                  )
                                  .catch(() => {})
                              }
                            >
                              Open in Finder
                            </button>
                          </div>
                          {agentMsgStep === "summary" && agentMsg && (
                            <JobStatus
                              busy={agentBusy}
                              message={agentMsg}
                              onDismiss={() => {
                                setAgentMsg(null);
                                setAgentMsgStep(null);
                              }}
                            />
                          )}
                        </section>

                        <section
                          className={`agent-step ${
                            !summaryUrlDraft.trim() && !source.summary_post_url
                              ? "agent-step--locked"
                              : ""
                          }`}
                        >
                          <div className="agent-step__head">
                            <div>
                              <h2 className="agent-step__title">
                                2 · Clip post generation
                              </h2>
                              <p className="agent-step__meta">
                                agent-export/clip/ · summary URL + prompt + transcript
                              </p>
                            </div>
                            <span
                              className={`agent-chip ${
                                summaryUrlDone ? "agent-chip--done" : ""
                              }`}
                            >
                              {summaryUrlDone ? "URL set" : "needs URL"}
                            </span>
                          </div>
                          <p className="agent-flow__step-copy">
                            Once you have a summary post, paste its URL so the
                            clipping agent has that context. Export writes{" "}
                            <code>01-reference.md</code>, editable{" "}
                            <code>02-prompt.md</code>, and{" "}
                            <code>03-transcript.md</code>. The agent should return a{" "}
                            <strong>JSON clip plan</strong> matching{" "}
                            <a
                              href="/CLIP_PLAN_SCHEMA.example.json"
                              target="_blank"
                              rel="noreferrer"
                            >
                              CLIP_PLAN_SCHEMA.example.json
                            </a>
                            — that JSON is what step 3 uses to create clips in
                            clipgenerator.
                          </p>
                          <label className="field">
                            <span className="field__label">Summary post URL</span>
                            <input
                              className="input"
                              type="url"
                              value={summaryUrlDraft}
                              onChange={(e) => setSummaryUrlDraft(e.target.value)}
                              onBlur={saveSummaryUrl}
                              placeholder="https://x.com/…/status/…"
                            />
                          </label>
                          <label className="field">
                            <span className="field__label">
                              Clip agent prompt{" "}
                              <span className="text-meta">
                                (saved on this device · written to 02-prompt.md)
                              </span>
                            </span>
                            <textarea
                              className="input agent-brief-panel__textarea"
                              rows={10}
                              value={clipPromptDraft}
                              onChange={(e) => setClipPromptDraft(e.target.value)}
                              onBlur={saveClipPrompt}
                              spellCheck={false}
                            />
                          </label>
                          <div className="clip-bar__row">
                            <button
                              type="button"
                              className="btn btn--primary"
                              onClick={exportClipPackage}
                              disabled={agentBusy || !summaryUrlDraft.trim()}
                            >
                              {agentBusy && agentMsgStep === "clip"
                                ? "Exporting…"
                                : "Export clip package"}
                            </button>
                            <button
                              type="button"
                              className="btn btn--paper"
                              onClick={() =>
                                api
                                  .revealPath(
                                    (source.folder || "") + "/agent-export/clip"
                                  )
                                  .catch(() => {})
                              }
                            >
                              Open in Finder
                            </button>
                          </div>
                          {agentMsgStep === "clip" && agentMsg && (
                            <JobStatus
                              busy={agentBusy}
                              message={agentMsg}
                              onDismiss={() => {
                                setAgentMsg(null);
                                setAgentMsgStep(null);
                              }}
                            />
                          )}
                        </section>

                        <section className="agent-step agent-step--live">
                          <div className="agent-step__head">
                            <div>
                              <h2 className="agent-step__title">3 · Generate clips</h2>
                              <p className="agent-step__meta">
                                import JSON plan · first clip selected
                              </p>
                            </div>
                            <span
                              className={`agent-chip ${
                                planDone ? "agent-chip--done" : ""
                              }`}
                            >
                              {planDone ? "imported" : "waiting"}
                            </span>
                          </div>
                          <p className="agent-flow__step-copy">
                            Paste the JSON returned by your clip agent (or choose a
                            file). It must match{" "}
                            <a
                              href="/CLIP_PLAN_SCHEMA.example.json"
                              target="_blank"
                              rel="noreferrer"
                            >
                              CLIP_PLAN_SCHEMA.example.json
                            </a>
                            . That plan creates the clips in the sidebar for trim,
                            captions, and export.
                          </p>
                          <label className="field">
                            <span className="field__label">Clip plan JSON</span>
                            <textarea
                              className="input agent-brief-panel__textarea agent-brief-panel__textarea--code"
                              rows={10}
                              value={planImportText}
                              onChange={(e) => setPlanImportText(e.target.value)}
                              placeholder={
                                '{\n  "version": 1,\n  "clips": [\n    {\n      "title": "…",\n      "t_in": 2628,\n      "t_out": 2785,\n      "post_text": "…",\n      "tags": ["@host"]\n    }\n  ]\n}'
                              }
                              spellCheck={false}
                            />
                          </label>
                          <div className="clip-bar__row">
                            <button
                              type="button"
                              className="btn btn--primary"
                              onClick={importClipPlan}
                              disabled={planImportBusy || !planImportText.trim()}
                            >
                              {planImportBusy ? "Importing…" : "Generate clips"}
                            </button>
                            <button
                              type="button"
                              className="btn btn--paper"
                              onClick={() => planFileRef.current?.click()}
                              disabled={planImportBusy}
                            >
                              Choose File
                            </button>
                          </div>
                          {agentMsgStep === "import" && agentMsg && (
                            <JobStatus busy={planImportBusy} message={agentMsg} />
                          )}
                          <input
                            ref={planFileRef}
                            type="file"
                            accept=".json,.md,.txt,application/json,text/plain"
                            className="sr-only"
                            onChange={onPlanFileChosen}
                          />
                        </section>
                        </div>
                      </div>
                    ) : paneTab === "post" ? (
                      <div className="paper paper--post">
                        <div className="paper__body">
                          {!activeClip ? (
                            <p className="transcript__empty">
                              Select a clip first, then write the post.
                            </p>
                          ) : (
                            <div className="post-package">
                              <div className="craft-zone__head">
                                <h3 className="craft-zone__title">
                                  The post
                                  {hasPostContent ? "" : " · optional"}
                                </h3>
                                <span className="post-package__count">
                                  {(activeClip.post_text || "").length} ch
                                </span>
                              </div>
                              {activeClip.why && (
                                <p className="post-package__why">
                                  why · {activeClip.why}
                                </p>
                              )}
                              <textarea
                                className="input paper-input"
                                rows={10}
                                value={activeClip.post_text || ""}
                                placeholder="Write or edit the X quote body…"
                                onChange={(e) => {
                                  const t = e.target.value;
                                  setSource((prev) => {
                                    if (!prev || !activeClipId) return prev;
                                    return {
                                      ...prev,
                                      clips: (prev.clips || []).map((c) =>
                                        c.id === activeClipId
                                          ? { ...c, post_text: t }
                                          : c
                                      ),
                                    };
                                  });
                                }}
                                onBlur={async (e) => {
                                  if (!source || !activeClip) return;
                                  const next = postWithHandles(
                                    e.target.value,
                                    activeClip.tags || []
                                  );
                                  try {
                                    await api.updateClip(source.id, activeClip.id, {
                                      post_text: next,
                                    });
                                    if (next !== e.target.value) {
                                      setSource((prev) => {
                                        if (!prev || !activeClipId) return prev;
                                        return {
                                          ...prev,
                                          clips: (prev.clips || []).map((c) =>
                                            c.id === activeClipId
                                              ? { ...c, post_text: next }
                                              : c
                                          ),
                                        };
                                      });
                                    }
                                  } catch (err) {
                                    setError(String(err.message || err));
                                  }
                                }}
                                spellCheck
                              />
                              <div className="post-package__actions">
                                <button
                                  type="button"
                                  className="btn btn--primary btn--sm"
                                  disabled={!(activeClip.post_text || "").trim()}
                                  onClick={() =>
                                    copyText(
                                      postWithHandles(
                                        activeClip.post_text || "",
                                        activeClip.tags || []
                                      ),
                                      "post"
                                    )
                                  }
                                >
                                  {copyFlash === "post" ? "Copied" : "Copy post"}
                                </button>
                              </div>

                              <div className="post-url-fields">
                                <label className="field">
                                  <span className="field__label">Summary URL</span>
                                  <input
                                    className="input"
                                    type="url"
                                    readOnly
                                    value={source.summary_post_url || ""}
                                    placeholder="No summary URL yet"
                                  />
                                  <button
                                    type="button"
                                    className="btn btn--primary btn--sm"
                                    disabled={!(source.summary_post_url || "").trim()}
                                    onClick={() =>
                                      copyText(source.summary_post_url || "", "summary")
                                    }
                                  >
                                    {copyFlash === "summary" ? "Copied" : "Copy"}
                                  </button>
                                </label>
                                <label className="field">
                                  <span className="field__label">Source URL</span>
                                  <input
                                    className="input"
                                    type="url"
                                    readOnly
                                    value={source.url || ""}
                                    placeholder="No source URL"
                                  />
                                  <button
                                    type="button"
                                    className="btn btn--primary btn--sm"
                                    disabled={!(source.url || "").trim()}
                                    onClick={() =>
                                      copyText(source.url || "", "source")
                                    }
                                  >
                                    {copyFlash === "source" ? "Copied" : "Copy"}
                                  </button>
                                </label>
                              </div>
                            </div>
                          )}
                        </div>
                      </div>
                    ) : paneTab === "captions" ? (
                      <div className="paper">
                        <div className="paper__body">
                          {!activeClip ? (
                            <p className="transcript__empty">Select a clip first.</p>
                          ) : !clipCaptions.length ? (
                            <div className="caption-empty">
                              <p className="caption-empty__hint">
                                Captions are built from the source transcript for this
                                clip&apos;s in/out. You still scrub the{" "}
                                <strong>source</strong> video; cue times are 0-based so
                                they match the exported file. Burn-in is not built —
                                export writes an .srt sidecar.
                              </p>
                              <button
                                type="button"
                                className="btn btn--primary"
                                onClick={generateCaptions}
                                disabled={captionsBusy}
                              >
                                {captionsBusy ? "Generating…" : "Generate captions"}
                              </button>
                            </div>
                          ) : (
                            <>
                              {captionsStale && (
                                <div className="caption-stale">
                                  You moved the in point after these were written.
                                  Regenerate, or the SRT will sit off the picture.
                                </div>
                              )}
                              <div className="caption-legend">
                                <span>0:00 = the first frame of the export</span>
                                <span>right margin = where it lives on the source</span>
                              </div>
                              <ul className="caption-list">
                                {clipCaptions.map((cap) => {
                                  const active =
                                    activeCaption && activeCaption.id === cap.id;
                                  return (
                                    <li
                                      key={cap.id}
                                      className={`caption-row ${
                                        active ? "caption-row--active" : ""
                                      }`}
                                    >
                                      <button
                                        type="button"
                                        className="caption-row__seek"
                                        title="Seek to this cue on the source video"
                                        onClick={() =>
                                          activeClip &&
                                          seekTo(
                                            activeClip.t_in + Number(cap.start)
                                          )
                                        }
                                      >
                                        {formatTs(cap.start)}
                                      </button>
                                      <textarea
                                        className="caption-row__text"
                                        rows={1}
                                        value={cap.text || ""}
                                        ref={(el) => {
                                          if (!el) return;
                                          el.style.height = "auto";
                                          el.style.height = `${el.scrollHeight}px`;
                                        }}
                                        onChange={(e) => {
                                          const el = e.target;
                                          el.style.height = "auto";
                                          el.style.height = `${el.scrollHeight}px`;
                                          patchCaptionLocal(cap.id, {
                                            text: e.target.value,
                                          });
                                        }}
                                        onBlur={persistCaptions}
                                        spellCheck
                                      />
                                      <button
                                        type="button"
                                        className="btn btn--icon btn--danger"
                                        title="Remove cue"
                                        onClick={() => removeCaptionAndSave(cap.id)}
                                      >
                                        ×
                                      </button>
                                    </li>
                                  );
                                })}
                              </ul>
                              <div className="caption-editor__footer">
                                <button
                                  type="button"
                                  className="btn btn--primary btn--sm"
                                  onClick={generateCaptions}
                                  disabled={captionsBusy}
                                >
                                  {captionsBusy
                                    ? "Generating…"
                                    : "Regenerate from transcript"}
                                </button>
                                <button
                                  type="button"
                                  className="btn btn--paper"
                                  onClick={persistCaptions}
                                >
                                  Save captions
                                </button>
                                <p className="caption-note">
                                  SRT beside the mp4 · burn-in is not built
                                </p>
                              </div>
                            </>
                          )}
                        </div>
                      </div>
                    ) : (
                      <>
                        <div className="paper">
                          <div className="paper__body paper__body--measure">
                            <div className="paper__grid">
                              <div className="paper__margin" aria-hidden>
                                {activeClip &&
                                  segments.length > 0 &&
                                  (() => {
                                    const first = segments[0]?.start ?? 0;
                                    const last =
                                      segments[segments.length - 1]?.end ??
                                      (sourceDuration || 1);
                                    const span = Math.max(0.001, last - first);
                                    const topPct = Math.min(
                                      100,
                                      Math.max(
                                        0,
                                        ((activeClip.t_in - first) / span) * 100
                                      )
                                    );
                                    const botPct = Math.min(
                                      100,
                                      Math.max(
                                        0,
                                        ((activeClip.t_out - first) / span) * 100
                                      )
                                    );
                                    const phPct = Math.min(
                                      100,
                                      Math.max(
                                        0,
                                        ((currentTime - first) / span) * 100
                                      )
                                    );
                                    const h = Math.max(0, botPct - topPct);
                                    return (
                                      <>
                                        <div
                                          className="paper__margin-rule"
                                          style={{
                                            top: `${topPct}%`,
                                            height: `${h}%`,
                                          }}
                                        />
                                        <div
                                          className="paper__margin-cap"
                                          style={{ top: `${topPct}%` }}
                                        />
                                        <div
                                          className="paper__margin-cap"
                                          style={{ top: `calc(${botPct}% - 2px)` }}
                                        />
                                        <span
                                          className="paper__margin-label"
                                          style={{ top: `calc(${topPct}% - 12px)` }}
                                        >
                                          in
                                        </span>
                                        <span
                                          className="paper__margin-label"
                                          style={{ top: `calc(${botPct}% + 4px)` }}
                                        >
                                          out
                                        </span>
                                        <div
                                          className="paper__margin-playhead"
                                          style={{ top: `${phPct}%` }}
                                        />
                                      </>
                                    );
                                  })()}
                              </div>
                              <div className="paper__text">
                                {segments.map((seg, i) => {
                                  const segIn =
                                    activeClip &&
                                    seg.start < activeClip.t_out &&
                                    seg.end > activeClip.t_in;
                                  return (
                                    <button
                                      type="button"
                                      id={`seg-${i}`}
                                      key={i}
                                      className={[
                                        "transcript-line",
                                        i === activeSegIndex
                                          ? "transcript-line--active"
                                          : "",
                                        segIn ? "transcript-line--in-range" : "",
                                      ]
                                        .filter(Boolean)
                                        .join(" ")}
                                      onClick={(e) => onSegClick(seg, e)}
                                    >
                                      <span className="transcript-line__ts">
                                        {formatTs(seg.start)}
                                      </span>
                                      <span className="transcript-line__text">
                                        {seg.text}
                                      </span>
                                    </button>
                                  );
                                })}
                                {!segments.length && (
                                  <p className="transcript__empty">
                                    No segments in transcript.
                                  </p>
                                )}
                              </div>
                            </div>
                          </div>
                        </div>
                        <div className="hint-row">
                          <span>
                            Click a transcript line to move the video playhead.
                            Press <strong>I</strong> to set the clip start and{" "}
                            <strong>O</strong> to set the clip end at the playhead.
                            Highlighted wash is this clip&apos;s range.
                          </span>
                        </div>
                      </>
                    )}
                  </div>
                </>
              )}
            </>
          )}
        </section>

        {source && source.status === "ready" && mediaSrc && (
          <aside className="craft-col">
            <div className="craft-col__scroll">
              <div className="monitor">
                <video
                  ref={videoRef}
                  src={mediaSrc}
                  controls
                  onTimeUpdate={(e) => setCurrentTime(e.target.currentTime)}
                />
                <div
                  className={`monitor__badge ${inRange ? "monitor__badge--in" : ""}`}
                >
                  {formatTs(currentTime)}
                  {inRange ? " · in clip" : ""}
                </div>
              </div>

              {activeClip && sourceDuration > 0 && (
                <div className="ruler">
                  <div className="ruler__head">
                    <span className="ruler__label">Source ruler</span>
                    <span className="ruler__meta">
                      {formatTs(sourceDuration)} · {clipCount} clip
                      {clipCount === 1 ? "" : "s"}
                    </span>
                  </div>
                  <div className="ruler__track" aria-hidden>
                    {(source.clips || [])
                      .filter((c) => c.id !== activeClipId)
                      .map((c) => (
                        <div
                          key={c.id}
                          className="ruler__ghost"
                          style={{
                            left: `${Math.min(
                              100,
                              Math.max(0, (c.t_in / sourceDuration) * 100)
                            )}%`,
                            width: `${Math.min(
                              100,
                              Math.max(
                                0.3,
                                ((c.t_out - c.t_in) / sourceDuration) * 100
                              )
                            )}%`,
                          }}
                        />
                      ))}
                    <div
                      className="ruler__range"
                      style={{
                        left: `${Math.min(
                          100,
                          Math.max(0, (activeClip.t_in / sourceDuration) * 100)
                        )}%`,
                        width: `${Math.min(
                          100,
                          Math.max(
                            0.4,
                            ((activeClip.t_out - activeClip.t_in) / sourceDuration) *
                              100
                          )
                        )}%`,
                      }}
                    />
                    <div
                      className="ruler__playhead"
                      style={{
                        left: `${Math.min(
                          100,
                          Math.max(0, (currentTime / sourceDuration) * 100)
                        )}%`,
                      }}
                    />
                  </div>
                  <div className="ruler__ticks" aria-hidden>
                    <span>0:00</span>
                    <span>{formatTs(sourceDuration / 2)}</span>
                    <span>{formatTs(sourceDuration)}</span>
                  </div>
                  <div className="ruler__legend">
                    <span>
                      <span className="ruler__swatch ruler__swatch--playhead" />
                      playhead
                    </span>
                    <span>
                      <span className="ruler__swatch ruler__swatch--clip" />
                      this clip
                    </span>
                    <span>
                      <span className="ruler__swatch ruler__swatch--other" />
                      other clips
                    </span>
                  </div>
                </div>
              )}

              <div className="craft-zone">
                <div className="craft-zone__head">
                  <h3 className="craft-zone__title">Clip</h3>
                </div>
                <label className="field">
                  <span className="field__label">Clip title</span>
                  <input
                    className="input input--serif"
                    value={activeClip?.title || ""}
                    onChange={(e) =>
                      setSource((prev) => ({
                        ...prev,
                        clips: (prev.clips || []).map((c) =>
                          c.id === activeClipId
                            ? { ...c, title: e.target.value }
                            : c
                        ),
                      }))
                    }
                    onBlur={(e) => saveClipPatch({ title: e.target.value })}
                    disabled={!activeClip}
                  />
                </label>
                <div className="mark-grid">
                  <div className="mark-grid__side">
                    <label className="field">
                      <span className="field__label">Start</span>
                      <input
                        className="input input--serif input--time"
                        value={inDraft}
                        onChange={(e) => setInDraft(e.target.value)}
                        onBlur={() => applyTypedTimes({ seek: "in" })}
                        onKeyDown={(e) => {
                          if (e.key === "Enter") {
                            e.preventDefault();
                            applyTypedTimes({ seek: "in" });
                          }
                        }}
                        placeholder="0:00"
                        disabled={!activeClip}
                      />
                    </label>
                    <button
                      type="button"
                      className="btn btn--mark"
                      onClick={setInFromPlayhead}
                      disabled={!activeClip}
                      title="Set start at playhead (I)"
                    >
                      Set start
                      <span className="kbd">I</span>
                    </button>
                  </div>
                  <div className="mark-grid__side">
                    <label className="field">
                      <span className="field__label">End</span>
                      <input
                        className="input input--serif input--time"
                        value={outDraft}
                        onChange={(e) => setOutDraft(e.target.value)}
                        onBlur={() => applyTypedTimes({ seek: "out" })}
                        onKeyDown={(e) => {
                          if (e.key === "Enter") {
                            e.preventDefault();
                            applyTypedTimes({ seek: "out" });
                          }
                        }}
                        placeholder="0:30"
                        disabled={!activeClip}
                      />
                    </label>
                    <button
                      type="button"
                      className="btn btn--mark"
                      onClick={setOutFromPlayhead}
                      disabled={!activeClip}
                      title="Set end at playhead (O)"
                    >
                      Set end
                      <span className="kbd">O</span>
                    </button>
                  </div>
                </div>
                <div className="mark-duration">
                  <span className="mark-duration__value">
                    {activeClip
                      ? `${Math.max(
                          0,
                          activeClip.t_out - activeClip.t_in
                        ).toFixed(1)}s`
                      : "—"}
                  </span>
                  <span className="mark-duration__human">
                    {activeClip
                      ? formatDurationHuman(activeClip.t_out - activeClip.t_in)
                      : ""}
                  </span>
                </div>
                <div className="mark-actions">
                  <button
                    type="button"
                    className="btn"
                    onClick={() => activeClip && seekTo(activeClip.t_in)}
                    disabled={!activeClip}
                  >
                    Play start
                  </button>
                  <button
                    type="button"
                    className="btn"
                    onClick={() =>
                      activeClip &&
                      seekTo(Math.max(0, (activeClip.t_out || 0) - 1))
                    }
                    disabled={!activeClip}
                  >
                    Play end
                  </button>
                  <button
                    type="button"
                    className="btn btn--primary"
                    onClick={() => applyTypedTimes({ seek: "in" })}
                    disabled={!activeClip}
                  >
                    Apply changes
                  </button>
                </div>
              </div>

              <div className="craft-zone craft-zone--captions">
                <div className="craft-zone__head">
                  <h3 className="craft-zone__title">Caption</h3>
                </div>
                <div className="clip-caption-actions">
                  <button
                    type="button"
                    className="btn"
                    onClick={generateCaptions}
                    disabled={!activeClip || captionsBusy}
                  >
                    {captionsBusy
                      ? "Generating…"
                      : clipCaptions.length
                        ? "Regenerate captions"
                        : "Generate captions"}
                  </button>
                  <button
                    type="button"
                    className="btn"
                    onClick={() => setPaneTab("captions")}
                    disabled={!activeClip}
                  >
                    Edit captions
                    {clipCaptions.length ? ` (${clipCaptions.length})` : ""}
                  </button>
                </div>
                {captionsBusy && (
                  <JobStatus busy message="Generating captions…" />
                )}
                {captionsMsg && !captionsBusy && (
                  <JobStatus
                    busy={false}
                    message={captionsMsg}
                    onDismiss={() => setCaptionsMsg(null)}
                  />
                )}
                {captionsStale && (
                  <p className="caption-stale caption-stale--craft">
                    Clip range changed since captions were generated — regenerate
                    for an accurate export.
                  </p>
                )}
              </div>

              <div className="craft-zone craft-zone--export">
                <div className="craft-zone__head">
                  <h3 className="craft-zone__title">Export</h3>
                </div>
                <div className="export-bar">
                  <button
                    type="button"
                    className="btn"
                    onClick={exportOne}
                    disabled={!activeClip || exportBusy}
                  >
                    {exportBusy
                      ? exportPercent != null
                        ? `Exporting… ${exportPercent}%`
                        : "Exporting…"
                      : "Export clip"}
                  </button>
                  <button
                    type="button"
                    className="btn btn--primary"
                    onClick={exportAll}
                    disabled={exportBusy || !clipCount}
                  >
                    Export all ({clipCount})
                  </button>
                </div>
                {exportStatusOpen && (
                  <JobStatus
                    busy={exportBusy}
                    title={
                      exportBusy
                        ? null
                        : exportFailed
                          ? "Export failed"
                          : "Export success"
                    }
                    message={exportMsg}
                    percent={exportPercent}
                    variant={
                      exportBusy ? undefined : exportFailed ? "error" : "success"
                    }
                    paths={
                      !exportBusy && !exportFailed && exportPaths.length
                        ? exportPaths
                        : undefined
                    }
                    onDismiss={() => {
                      setExportStatusOpen(false);
                      setExportMsg(null);
                      setExportPath(null);
                      setExportFailed(false);
                    }}
                    onReveal={
                      !exportBusy &&
                      !exportFailed &&
                      (exportPath || activeClip?.export_path)
                        ? revealExport
                        : undefined
                    }
                    revealLabel="Open in Finder"
                  />
                )}
              </div>
            </div>
          </aside>
        )}

        {!source && (
          <aside className="craft-col craft-col--welcome">
            <div className="empty-card">
              <h3 className="empty-card__title">Transcription model</h3>
              <p className="empty-card__body">
                <strong>small · lightest:</strong> the daily driver at any length.
                ~5 min on a 1.5h English pod.
              </p>
              <p className="empty-card__body">
                <strong>medium · mid:</strong> stronger than small. Prefer under
                ~45–60 min, or when small mangles names/jargon.
              </p>
            </div>
            <div className="empty-card empty-card--warn">
              <p className="empty-card__body">
                Make sure the Whisper model you pick is already downloaded (MLX
                models land on first use and can take a while). If something fails
                or looks wrong, check the project README for setup and
                troubleshooting.
              </p>
            </div>
            <p className="empty-foot">
              local only · nothing leaves this machine
              <br />
              library lives in data/library.json
            </p>
          </aside>
        )}
      </div>
    </div>
  );
}
