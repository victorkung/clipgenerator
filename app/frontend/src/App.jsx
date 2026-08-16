import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { api, formatTs } from "./api";
import { agentStartMs, elapsedSeconds, formatClock } from "./agentClock";
import CaptionEditor from "./CaptionEditor";
import AgentDesk, { inferAgentStep } from "./AgentDesk";

const DEFAULT_STAGES = [
  { id: "queued", label: "Queued" },
  { id: "resolving", label: "Resolve" },
  { id: "downloading", label: "Download" },
  { id: "transcribing", label: "Transcribe" },
  { id: "done", label: "Ready" },
];

/** Daily-driver models only. Labels short; `guide` = when to pick this. */
const WHISPER_MODELS = [
  {
    id: "small",
    label: "small · faster",
    guide:
      "Default. Best speed/quality for most shows. Use for long episodes when you need clip finding more than perfect names.",
  },
  {
    id: "medium",
    label: "medium · clearer",
    guide:
      "When small mangles names, tickers, or jargon — or audio is noisy. ~2× slower; worth it when caption accuracy matters.",
  },
];

/** Soft threshold for “this might be a promo clip, not the full episode.” */
const SHORT_SOURCE_SECS = 90;

function isXStatusUrl(url) {
  return /(?:x\.com|twitter\.com)\/[^/]+\/status\/\d+/i.test(String(url || ""));
}

const AGENT_BUSY_LABEL = {
  summary: "drafting",
  clips: "clips",
  writer: "writer",
  captions: "packaging",
  reply: "reply",
};

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

function listRunningAgents(source) {
  const run = source?.agent_run || {};
  const out = [];
  const rows = [
    ["captions", "captions", "desk"],
    ["writer", "writer", "desk"],
    ["clips", "clips", "desk"],
    ["summary", "summary", "desk"],
    ["reply", "reply", "reply"],
  ];
  for (const [key, step, lock] of rows) {
    const st = run[key] || {};
    if (st.status === "running" && st.job_id) {
      out.push({ step, jobId: st.job_id, lock });
    }
  }
  return out;
}

/** Bump when default task prompts change so devices pick up the new text. */
const LS_SUMMARY_PROMPT = "clipgenerator.agent.summaryPrompt.v3";
const LS_CLIP_PROMPT = "clipgenerator.agent.clipPrompt.v4";
const LS_CAPTION_STYLE = "clipgenerator.captionStyle";
const LS_CRAFT_COLLAPSED = "clipgenerator.craftCollapsed";

/** App-wide burn-in style (viral plate — not Desk chrome). Saved on this device. */
const DEFAULT_CAPTION_STYLE = {
  font: "serif", // serif | sans
  plate: "cream", // cream | night
  anchor: "bottom", // top | middle | lower_third | bottom
  align: "center", // left | center | right
  offset_y: 0,
  font_size: 0.052,
  max_width: 0.86,
  burn: true,
};

function loadCaptionStyle() {
  try {
    const raw = localStorage.getItem(LS_CAPTION_STYLE);
    if (!raw) return { ...DEFAULT_CAPTION_STYLE };
    const parsed = JSON.parse(raw);
    return normalizeCaptionStyleClient(parsed);
  } catch {
    return { ...DEFAULT_CAPTION_STYLE };
  }
}

function normalizeCaptionStyleClient(raw) {
  const base = { ...DEFAULT_CAPTION_STYLE };
  if (!raw || typeof raw !== "object") return base;
  if (raw.font === "serif" || raw.font === "sans") base.font = raw.font;
  if (raw.plate === "cream" || raw.plate === "night") base.plate = raw.plate;
  if (["top", "middle", "lower_third", "bottom"].includes(raw.anchor)) {
    base.anchor = raw.anchor;
  }
  if (["left", "center", "right"].includes(raw.align)) base.align = raw.align;
  const oy = Number(raw.offset_y);
  if (!Number.isNaN(oy)) base.offset_y = Math.max(-0.2, Math.min(0.2, oy));
  const fs = Number(raw.font_size);
  if (!Number.isNaN(fs)) base.font_size = Math.max(0.03, Math.min(0.09, fs));
  const mw = Number(raw.max_width);
  if (!Number.isNaN(mw)) base.max_width = Math.max(0.5, Math.min(0.95, mw));
  if (raw.burn === false) base.burn = false;
  return base;
}

function saveCaptionStyle(style) {
  try {
    localStorage.setItem(LS_CAPTION_STYLE, JSON.stringify(style));
  } catch {
    /* ignore */
  }
}

/** Default summary-agent prompt (shared across all sources; editable). */
const DEFAULT_SUMMARY_PROMPT = `# Thread opener (summary agent)

clipgenerator already transcribed the source and packaged the files below. Treat the transcript as the source of truth.

## Files

- \`01-reference.md\` — title, source URL, duration
- \`02-prompt.md\` — this prompt
- \`03-transcript.md\` — full timestamped transcript

## What to produce

For this episode we are shipping a **thread** (a series of posts), not a standalone long recap alone.

**Post 1** is an **initial teaser** for the rest of the thread. Later posts (handled by the clip agent) will be **clips of the most actionable takeaways**.

Modify the structure you usually use for summary posts. For this opener, only produce:

1. **title / hook**
2. **intro** (tight; tag main people)
3. **tldrs** — a bit meatier than one-liners; each TLDR may be its own short section if it helps
4. **call-to-action** — tell the reader to keep reading the thread for the clips / actionable takeaways

### TLDR rules

- **Thematic, not chronological** — group by idea / lesson, not by when it appeared in the episode
- Do **not** write the old long **key takeaways** essay sections in this post — leave depth for the clip replies
- Still keep your usual voice, honesty, and scannability
- Do **not** draft a reply under the original. That is generated at the end from the finished thread.

Edit with the human until ready to ship.
`;

/** Default clip-agent prompt (shared across all sources; editable). */
const DEFAULT_CLIP_PROMPT = `# Clip plan — replies in the thread

clipgenerator packaged this episode for an external clip agent.

## Files

- \`01-reference.md\` — title, source URL, duration
- \`02-prompt.md\` — this prompt
- \`03-transcript.md\` — full timestamped transcript (source of truth)
- \`04-summary.md\` — **thread opener** from the Summary agent (the first post of the thread)

## How this ships (different from quote-each-clip)

We are **not** posting a long summary and then quoting that summary with each clip as a separate standalone.

\`04-summary.md\` is the **initial post of a thread**. Your job is to find **clips that become additional replies in that same thread**.

Each clip = its own post in the larger thread. Objective: give the reader an easy way to learn the lessons from the original transcript.

## Selection + narrative

- Hit the **tldrs / themes** in \`04-summary.md\` — the clip sequence should make those concrete
- Also pull strong walkthroughs / worked examples from the transcript when they teach process (entries, risk, sizing, mistakes) — not only abstract soundbites
- Think **narrative** when choosing clips **and** when writing captions
- Think carefully about **order** of the posts (thread arc), not only rank-by-virality
- Still follow your usual workflow: shortlist → human selects → one clip at a time → value-first captions with context

## Import JSON

When asked, output import JSON for **video clip posts only** (not the thread opener). Shape: CLIP_PLAN_SCHEMA.example.json — per clip \`title\`, \`t_in\`/\`t_out\`, \`post_text\`; optional \`tags\`, \`why\`. Include clips in the intended thread order.
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


/** Strip trailing "14%" / "· 14%" so we never show percent twice. */
function stripTrailingPercent(msg) {
  return String(msg || "")
    .replace(/(?:\s*[·•.…]?\s*)\d{1,3}\s*%\s*$/g, "")
    .replace(/\s+\d{1,3}\s*%\s*$/g, "")
    .trim();
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
  // One percent only — prefer the numeric `percent` prop; scrub any % already in message.
  const cleanMsg = stripTrailingPercent(message);
  const showPct = busy && percent != null && Number.isFinite(percent);
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
              ? cleanMsg || "Working…"
              : title || (tone === "error" ? "Export failed" : "Export success")}
            {showPct && (
              <span className="banner__pct"> · {Math.round(percent)}%</span>
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

function formatElapsedLabel(seconds) {
  if (seconds == null || Number.isNaN(Number(seconds))) return null;
  const s = Math.max(0, Math.floor(Number(seconds)));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  if (h > 0) return `${h}h ${String(m).padStart(2, "0")}m`;
  if (m > 0) return `${m}m ${String(sec).padStart(2, "0")}s`;
  return `${sec}s`;
}

/** Prefer live job.pipeline, then persisted source.pipeline */
function getPipeline(source) {
  return source?.job?.pipeline || source?.pipeline || null;
}

function stageDurationS(pipeline, name) {
  const st = pipeline?.stages?.[name];
  if (!st || st.duration_s == null) return null;
  return Number(st.duration_s);
}

/** Compact timing chips for compare-across-sources (and live job). */
function PipelineTiming({ source, compact = false }) {
  const pipe = getPipeline(source);
  if (!pipe) return null;
  const resolveS = stageDurationS(pipe, "resolve");
  const downloadS = stageDurationS(pipe, "download");
  const extractS =
    stageDurationS(pipe, "extract") ??
    pipe?.stages?.transcribe?.extract_s ??
    null;
  const whisperS =
    stageDurationS(pipe, "whisper") ??
    pipe?.stages?.transcribe?.whisper_s ??
    null;
  const sttS = stageDurationS(pipe, "transcribe");
  const totalS = pipe.total_s != null ? Number(pipe.total_s) : null;
  const rtf = pipe.stt_realtime_factor;
  const estimated = !!pipe.estimated;
  const parts = [];
  if (resolveS != null) parts.push({ k: "resolve", v: formatElapsedLabel(resolveS) });
  if (downloadS != null) parts.push({ k: "download", v: formatElapsedLabel(downloadS) });
  if (extractS != null) parts.push({ k: "extract", v: formatElapsedLabel(extractS) });
  if (whisperS != null) parts.push({ k: "whisper", v: formatElapsedLabel(whisperS) });
  else if (sttS != null) parts.push({ k: "STT", v: formatElapsedLabel(sttS) });
  if (totalS != null && !compact) parts.push({ k: "total", v: formatElapsedLabel(totalS) });
  if (rtf != null) parts.push({ k: "RTF", v: `${Number(rtf).toFixed(1)}×` });
  if (!parts.length && !pipe.started_at) return null;

  return (
    <div
      className={`pipeline-timing ${compact ? "pipeline-timing--compact" : ""}`}
      title={
        estimated
          ? "Estimated from file timestamps (source predated analytics)"
          : "Wall-clock pipeline timing"
      }
    >
      {!compact && (
        <div className="pipeline-timing__label">
          Pipeline timing{estimated ? " (est.)" : ""}
          {pipe.model ? ` · ${pipe.model}` : ""}
          {pipe.audio_duration_s != null
            ? ` · audio ${formatElapsedLabel(pipe.audio_duration_s)}`
            : ""}
        </div>
      )}
      <div className="pipeline-timing__chips">
        {parts.map((p) => (
          <span key={p.k} className="pipeline-timing__chip text-mono">
            <span className="pipeline-timing__k">{p.k}</span> {p.v}
          </span>
        ))}
        {compact && estimated && (
          <span className="pipeline-timing__chip pipeline-timing__chip--muted">est.</span>
        )}
      </div>
      {!compact && rtf != null && rtf < 5 && (
        <p className="pipeline__detail pipeline__detail--note">
          STT under ~5× realtime usually means memory pressure or thermal
          throttle (healthy Macs often hit 15–40× on small).
        </p>
      )}
    </div>
  );
}

function SttHealthBanner({ health, rtf, etaS }) {
  if (!health || !health.level || health.level === "starting") return null;
  if (health.level === "ok") return null;
  const level = health.level;
  const cls =
    level === "stalled" || level === "critical"
      ? "stt-health stt-health--critical"
      : level === "slow"
        ? "stt-health stt-health--slow"
        : "stt-health";
  const title =
    level === "stalled"
      ? "On-device transcription stalled"
      : level === "critical"
        ? "On-device transcription issue"
        : "On-device transcription is slow";
  return (
    <div className={cls} role="status">
      <div className="stt-health__title">{title}</div>
      <p className="stt-health__msg">{health.message}</p>
      <p className="stt-health__meta text-mono">
        {rtf != null ? `${Number(rtf).toFixed(1)}× realtime` : "no RTF yet"}
        {health.rtf_healthy_min != null
          ? ` · healthy ≥${Number(health.rtf_healthy_min).toFixed(0)}×`
          : ""}
        {health.percent != null ? ` · ${Number(health.percent).toFixed(0)}% audio` : ""}
        {etaS != null ? ` · ETA ~${formatElapsedLabel(etaS)}` : ""}
        {health.code ? ` · ${health.code}` : ""}
      </p>
      {(level === "stalled" || level === "critical") && (
        <p className="stt-health__hint">
          This is measured decode throughput vs other sources on this Mac — not a
          guess. Cancel and retry, or check Activity Monitor for a stuck Python/MLX
          process. Larger files can still finish faster when health is ok.
        </p>
      )}
    </div>
  );
}

function PipelineProgress({ source }) {
  const job = source.job || {};
  const stages = job.stages || DEFAULT_STAGES;
  const stage = job.stage || source.status || "queued";
  const idx = stageIndex(stage, stages);
  const sttHealth = job.stt_health;
  const healthLevel = sttHealth?.level;
  const hasLiveStt =
    stage === "transcribing" && typeof job.percent === "number";
  const indeterminate =
    job.progress_kind === "indeterminate" ||
    (stage === "transcribing" && !hasLiveStt);
  const percent =
    !indeterminate && typeof job.percent === "number"
      ? job.percent
      : !indeterminate
        ? Math.round((idx / Math.max(1, stages.length - 1)) * 100)
        : null;
  const msg = job.message || source.status;
  const detail = job.detail;
  const elapsedLabel = formatElapsedLabel(job.elapsed_s);
  const pipe = getPipeline(source);
  const doneStageTimes = {
    resolve: stageDurationS(pipe, "resolve"),
    download: stageDurationS(pipe, "download"),
    transcribe: stageDurationS(pipe, "transcribe"),
  };

  return (
    <div className="pipeline">
      <SttHealthBanner
        health={sttHealth}
        rtf={job.stt_rtf ?? sttHealth?.rtf}
        etaS={job.eta_s}
      />
      <p className="pipeline__headline">
        {msg || "Working on this source…"}
      </p>
      <div
        className={`pipeline__track ${
          indeterminate ? "pipeline__track--indeterminate" : ""
        } ${
          healthLevel === "critical" || healthLevel === "stalled"
            ? "pipeline__track--critical"
            : healthLevel === "slow"
              ? "pipeline__track--slow"
              : ""
        }`}
        aria-hidden
      >
        {indeterminate ? (
          <div className="pipeline__fill pipeline__fill--indeterminate" />
        ) : (
          <div
            className="pipeline__fill"
            style={{ width: `${Math.min(100, Math.max(2, percent ?? 2))}%` }}
          />
        )}
      </div>
      <div className="pipeline__steps">
        {stages.map((st, i) => {
          let cls = "pipeline__step";
          if (stage === "error") cls += i <= idx ? " pipeline__step--error" : "";
          else if (i < idx) cls += " pipeline__step--done";
          else if (i === idx) cls += " pipeline__step--active";
          const stageKey =
            st.id === "resolving"
              ? "resolve"
              : st.id === "downloading"
                ? "download"
                : st.id === "transcribing"
                  ? "transcribe"
                  : null;
          const doneDur =
            stageKey && i < idx ? doneStageTimes[stageKey] : null;
          return (
            <div key={st.id} className={cls}>
              <div className="pipeline__dot" />
              <span>
                {st.label}
                {i < idx ? " ✓" : ""}
                {doneDur != null ? ` · ${formatElapsedLabel(doneDur)}` : ""}
                {i === idx &&
                !indeterminate &&
                typeof percent === "number" &&
                (stage === "downloading" || stage === "transcribing")
                  ? ` · ${Number(percent).toFixed(0)}%`
                  : ""}
                {i === idx && indeterminate && elapsedLabel
                  ? ` · ${elapsedLabel}`
                  : ""}
                {i === idx &&
                stage === "transcribing" &&
                job.stt_rtf != null &&
                !indeterminate
                  ? ` · ${Number(job.stt_rtf).toFixed(1)}×`
                  : ""}
              </span>
            </div>
          );
        })}
      </div>
      {detail && <p className="pipeline__detail">{detail}</p>}
      <PipelineTiming source={source} />
      {stage === "transcribing" && indeterminate && (
        <p className="pipeline__detail pipeline__detail--note">
          Waiting for first decode tick (model load). After that you’ll see % of
          audio and live realtime factor — health alerts fire if STT falls far
          below normal for this Mac.
        </p>
      )}
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
  const [publishConfigured, setPublishConfigured] = useState(false);
  const [publishPreview, setPublishPreview] = useState(null);
  const [origUrlDraft, setOrigUrlDraft] = useState("");
  const [queueAt, setQueueAt] = useState("");
  const [typefullyStatus, setTypefullyStatus] = useState(null);
  const [typefullyBusy, setTypefullyBusy] = useState(false);
  const [publishBusy, setPublishBusy] = useState(false);
  const [publishMsg, setPublishMsg] = useState(null);
  const [publishFailed, setPublishFailed] = useState(false);
  const [captionsMsg, setCaptionsMsg] = useState(null);
  const [captionJob, setCaptionJob] = useState(null);
  const captionJobRef = useRef(null);
  const [agentUi, setAgentUi] = useState({});
  const agentUiRef = useRef({});
  const agentPollsRef = useRef({});
  const [agentStep, setAgentStep] = useState("opener");
  const [planImportText, setPlanImportText] = useState("");
  const [planImportBusy, setPlanImportBusy] = useState(false);
  const [paneTab, setPaneTab] = useState("transcript"); // agent | transcript | captions | post | publish
  const [agentFlowEnabled, setAgentFlowEnabled] = useState(false);
  const [xaiReady, setXaiReady] = useState(false);
  const [agentPack, setAgentPack] = useState("generic");
  const [inDraft, setInDraft] = useState("");
  const [outDraft, setOutDraft] = useState("");
  const [titleDraft, setTitleDraft] = useState("");
  const [editingTitle, setEditingTitle] = useState(false);
  /** Local draft so poll/reload can't wipe mid-edit (same idea as source titleDraft). */
  const [clipTitleDraft, setClipTitleDraft] = useState("");
  /** Local draft for the post textarea — saved on blur / clip switch. */
  const [postDraft, setPostDraft] = useState("");
  const [summaryPromptDraft, setSummaryPromptDraft] = useState(() =>
    loadSharedPrompt(LS_SUMMARY_PROMPT, DEFAULT_SUMMARY_PROMPT)
  );
  const [clipPromptDraft, setClipPromptDraft] = useState(() =>
    loadSharedPrompt(LS_CLIP_PROMPT, DEFAULT_CLIP_PROMPT)
  );
  const [captionStyle, setCaptionStyle] = useState(() => loadCaptionStyle());
  /** Craft rail accordion — all open by default so first visit shows everything. */
  const [craftOpen, setCraftOpen] = useState({
    clip: true,
    caption: true,
    export: true,
  });
  const [craftCollapsed, setCraftCollapsed] = useState(() => {
    try {
      return localStorage.getItem(LS_CRAFT_COLLAPSED) === "1";
    } catch {
      return false;
    }
  });
  const [summaryTextDraft, setSummaryTextDraft] = useState("");
  const [importNotice, setImportNotice] = useState(null);
  const [retryBusy, setRetryBusy] = useState(false);
  /** Pipeline timing popover (ready sources — not shown by default). */
  const [timingInfoOpen, setTimingInfoOpen] = useState(false);
  const [copyFlash, setCopyFlash] = useState(null);
  const videoRef = useRef(null);
  const monitorRef = useRef(null);
  const titleInputRef = useRef(null);
  const planFileRef = useRef(null);
  const selectedIdRef = useRef(selectedId);
  /** True while the open source is still ingesting — used to reload once it finishes. */
  const selectedWasInflightRef = useRef(false);
  const exportOwnerIdRef = useRef(null);
  const copyTimerRef = useRef(null);
  const promptServerSyncRef = useRef(null);
  /** Last transcript segment index we scrolled to; used to distinguish jump vs playhead crawl. */
  const prevSegIndexRef = useRef(-1);
  /** Next activeSegIndex scroll should pin to top (clip select / explicit jump). */
  const forceTranscriptJumpRef = useRef(false);
  const activeClipIdRef = useRef(activeClipId);
  const editingTitleRef = useRef(editingTitle);
  const clipTitleFocusedRef = useRef(false);
  const clipTitleDraftRef = useRef("");
  /** Last title known saved for the active clip (blur compares against this). */
  const clipTitleSavedRef = useRef("");
  const postFocusedRef = useRef(false);
  const postDraftRef = useRef("");
  const captionFocusedRef = useRef(false);
  const captionsDraftRef = useRef(null);
  const captionHandlersRef = useRef({});
  const currentTimeRef = useRef(0);
  const lastTimeTickRef = useRef(0);
  /** Last post_text known saved for the active clip. */
  const postSavedRef = useRef("");
  /** sourceId + clipId the draft belongs to (blur/switch commit). */
  const postOwnerRef = useRef({ sourceId: null, clipId: null, tags: [] });
  activeClipIdRef.current = activeClipId;
  editingTitleRef.current = editingTitle;
  if (
    ["pending", "downloading", "transcribing"].includes(source?.status)
  ) {
    selectedWasInflightRef.current = true;
  }
  clipTitleDraftRef.current = clipTitleDraft;
  postDraftRef.current = postDraft;
  const [videoBox, setVideoBox] = useState({
    left: 0,
    top: 0,
    width: 0,
    height: 0,
  });
  /** Server-rendered plate PNG (same as export) for the active cue. */
  const [platePreview, setPlatePreview] = useState(null);
  const platePreviewKeyRef = useRef("");
  const platePreviewTimerRef = useRef(null);
  /** Monitor container is fullscreen (video + caption overlay). */
  const [monitorFullscreen, setMonitorFullscreen] = useState(false);
  /** Pixel positions for transcript margin in/out/playhead (aligned to line DOM). */
  const [marginMarks, setMarginMarks] = useState(null);
  const paperGridRef = useRef(null);

  const patchAgentUi = useCallback((sourceId, patch) => {
    if (!sourceId) return;
    const cur = agentUiRef.current[sourceId] || {};
    const nextRow = { ...cur, ...patch };
    const next = { ...agentUiRef.current, [sourceId]: nextRow };
    agentUiRef.current = next;
    setAgentUi(next);
  }, []);

  const anyAgentBusy = Object.values(agentUi).some(
    (row) => row?.busy || row?.replyBusy
  );
  const [agentNow, setAgentNow] = useState(() => Date.now());
  useEffect(() => {
    if (!anyAgentBusy) return undefined;
    setAgentNow(Date.now());
    const id = setInterval(() => setAgentNow(Date.now()), 1000);
    return () => clearInterval(id);
  }, [anyAgentBusy]);

  const isSourceBusy = useCallback((sourceId) => {
    return !!agentUiRef.current[sourceId]?.busy;
  }, []);

  const isSourceReplyBusy = useCallback((sourceId) => {
    return !!agentUiRef.current[sourceId]?.replyBusy;
  }, []);

  const watchAgentJob = useCallback(
    async (sourceId, jobId, { lock = "desk", step, onTick } = {}) => {
      if (!sourceId || !jobId) return null;
      const key = `${sourceId}:${lock}`;
      agentPollsRef.current[key] = jobId;
      if (lock === "reply") {
        patchAgentUi(sourceId, { replyBusy: true });
      } else {
        const cur = agentUiRef.current[sourceId] || {};
        patchAgentUi(sourceId, {
          busy: true,
          step,
          jobId,
          startedAt: cur.startedAt || Date.now(),
        });
      }
      try {
        let job;
        for (;;) {
          if (agentPollsRef.current[key] !== jobId) return null;
          job = await api.getAgentJob(jobId);
          if (lock === "desk") {
            const tick = {};
            if (job.message) tick.msg = job.message;
            if (job.percent != null) tick.percent = job.percent;
            const parsed = Date.parse(job.started_at || "");
            if (Number.isFinite(parsed) && !agentUiRef.current[sourceId]?.startedAt) {
              tick.startedAt = parsed;
            }
            if (Object.keys(tick).length) patchAgentUi(sourceId, tick);
          }
          onTick?.(job);
          if (job.status === "done" || job.status === "error") break;
          await sleep(800);
        }
        return job;
      } finally {
        if (agentPollsRef.current[key] === jobId) {
          delete agentPollsRef.current[key];
          patchAgentUi(
            sourceId,
            lock === "reply" ? { replyBusy: false } : { busy: false, percent: null }
          );
        }
      }
    },
    [patchAgentUi]
  );

  const refreshList = useCallback(async () => {
    const list = await api.listSources();
    setSources(list);
    return list;
  }, []);

  const loadSource = useCallback(async (id) => {
    if (!id) {
      if (selectedIdRef.current == null) {
        setSource(null);
        setTranscript(null);
      }
      return;
    }
    const s = await api.getSource(id);
    const isActive = selectedIdRef.current === id;
    // Preserve in-progress title/post if those fields are focused (reload/poll must not wipe).
    let next = s;
    const dirtyId = activeClipIdRef.current;
    if (
      isActive &&
      dirtyId &&
      (clipTitleFocusedRef.current ||
        postFocusedRef.current ||
        captionFocusedRef.current)
    ) {
      next = {
        ...s,
        clips: (s.clips || []).map((c) => {
          if (c.id !== dirtyId) return c;
          const merged = { ...c };
          if (clipTitleFocusedRef.current) merged.title = clipTitleDraftRef.current;
          if (postFocusedRef.current) merged.post_text = postDraftRef.current;
          if (captionFocusedRef.current && captionsDraftRef.current) {
            merged.captions = captionsDraftRef.current;
          }
          return merged;
        }),
      };
    }
    // Sidebar reads `sources`, not `source` — mirror job/status so % / RTF tick live
    // without waiting on a second list fetch (and without a full page refresh).
    setSources((list) => {
      let found = false;
      const mapped = list.map((row) => {
        if (row.id !== next.id) return row;
        found = true;
        return {
          ...row,
          status: next.status,
          error: next.error,
          model: next.model ?? row.model,
          duration: next.duration ?? row.duration,
          job: next.job,
          pipeline: next.pipeline ?? row.pipeline,
          clips: next.clips ?? row.clips,
          agent_run: next.agent_run ?? row.agent_run,
          summary_post_text: next.summary_post_text ?? row.summary_post_text,
        };
      });
      return found ? mapped : list;
    });
    if (!isActive) return next;
    setSource(next);
    // Refs keep this callback stable so selectedId effect does not re-fetch on clip changes.
    if (!editingTitleRef.current) setTitleDraft(s.title || "");
    // Agent prompts are app-wide (localStorage); do not reset per source
    setSummaryTextDraft(s.summary_post_text || "");
    setOrigUrlDraft(
      s.summary_post_url || (isXStatusUrl(s.url) ? s.url : "") || ""
    );
    setOrigUrlDraft(
      s.summary_post_url || (isXStatusUrl(s.url) ? s.url : "") || ""
    );
    if (s.status === "ready" && s.transcript_json) {
      try {
        const t = await api.getTranscript(id);
        if (selectedIdRef.current === id) setTranscript(t);
      } catch {
        if (selectedIdRef.current === id) setTranscript(null);
      }
    } else {
      setTranscript(null);
    }
    const clips = s.clips || [];
    const curClip = activeClipIdRef.current;
    if (clips.length && !clips.find((c) => c.id === curClip)) {
      setActiveClipId(clips[0].id);
    }
    return next;
  }, []);

  const applySourceUpdate = useCallback((sourceId, updated) => {
    if (!updated || !sourceId) return;
    if (selectedIdRef.current === sourceId) {
      setSource((prev) =>
        prev && prev.id === sourceId ? { ...prev, ...updated } : updated
      );
      if (updated.summary_post_text != null) {
        setSummaryTextDraft(updated.summary_post_text);
      }
    }
    setSources((list) =>
      list.map((row) => (row.id === sourceId ? { ...row, ...updated } : row))
    );
  }, []);

  const resumeAgentIfNeeded = useCallback(
    (s) => {
      if (!s?.id) return;
      for (const found of listRunningAgents(s)) {
        const key = `${s.id}:${found.lock}`;
        if (agentPollsRef.current[key] === found.jobId) continue;
        patchAgentUi(
          s.id,
          found.lock === "reply"
            ? { replyBusy: true }
            : {
                busy: true,
                step: found.step,
                jobId: found.jobId,
                msg: "Working…",
                startedAt:
                  agentUiRef.current[s.id]?.startedAt ||
                  agentStartMs(s, null, found.step) ||
                  Date.now(),
              }
        );
        void (async () => {
          const job = await watchAgentJob(s.id, found.jobId, {
            lock: found.lock,
            step: found.step,
          });
          if (!job) return;
          try {
            await loadSource(s.id);
          } catch {
            /* keep last known source */
          }
          if (found.lock === "desk") {
            patchAgentUi(s.id, { msg: job.message || null });
          }
          if (job.status === "error" && selectedIdRef.current === s.id) {
            setError(job.error || job.message || "agent failed");
          }
        })();
      }
    },
    [loadSource, patchAgentUi, watchAgentJob]
  );

  // Keep agent prompts on this device: write localStorage on every edit (survives reload).
  useEffect(() => {
    saveSharedPrompt(LS_SUMMARY_PROMPT, summaryPromptDraft);
  }, [summaryPromptDraft]);

  useEffect(() => {
    saveSharedPrompt(LS_CLIP_PROMPT, clipPromptDraft);
  }, [clipPromptDraft]);

  // App-wide caption plate style (burn-in + preview)
  useEffect(() => {
    saveCaptionStyle(captionStyle);
  }, [captionStyle]);

  function patchCaptionStyle(partial) {
    setCaptionStyle((prev) => normalizeCaptionStyleClient({ ...prev, ...partial }));
  }

  function toggleCraftSection(key) {
    setCraftOpen((prev) => ({ ...prev, [key]: !prev[key] }));
  }

  /** Map overlay to the letterboxed video picture (object-fit: contain). */
  const measureVideoBox = useCallback(() => {
    const v = videoRef.current;
    if (!v) return;
    const cw = v.clientWidth;
    const ch = v.clientHeight;
    const vw = v.videoWidth || 0;
    const vh = v.videoHeight || 0;
    if (!cw || !ch || !vw || !vh) {
      setVideoBox({ left: 0, top: 0, width: cw, height: ch });
      return;
    }
    const scale = Math.min(cw / vw, ch / vh);
    const width = vw * scale;
    const height = vh * scale;
    setVideoBox({
      left: (cw - width) / 2,
      top: (ch - height) / 2,
      width,
      height,
    });
  }, []);

  function getFullscreenElement() {
    return (
      document.fullscreenElement ||
      document.webkitFullscreenElement ||
      null
    );
  }

  async function requestElFullscreen(el) {
    if (!el) return;
    if (el.requestFullscreen) return el.requestFullscreen();
    if (el.webkitRequestFullscreen) return el.webkitRequestFullscreen();
  }

  async function exitDocumentFullscreen() {
    if (document.exitFullscreen) return document.exitFullscreen();
    if (document.webkitExitFullscreen) return document.webkitExitFullscreen();
  }

  const fsLockRef = useRef(false);

  function unlockFsSoon() {
    window.setTimeout(() => {
      fsLockRef.current = false;
    }, 400);
  }

  async function enterMonitorFullscreen() {
    const mon = monitorRef.current;
    const v = videoRef.current;
    if (!mon) return;
    fsLockRef.current = true;
    try {
      // Safari native video presentation is not the Fullscreen API
      if (v?.webkitDisplayingFullscreen && v.webkitExitFullscreen) {
        v.webkitExitFullscreen();
      }
      if (
        v?.webkitPresentationMode &&
        v.webkitPresentationMode !== "inline" &&
        v.webkitSetPresentationMode
      ) {
        v.webkitSetPresentationMode("inline");
      }
      const fs = getFullscreenElement();
      if (fs && fs !== mon) {
        await exitDocumentFullscreen();
        await new Promise((r) => window.setTimeout(r, 80));
      }
      if (getFullscreenElement() !== mon) {
        await requestElFullscreen(mon);
      }
    } catch {
      /* user gesture / browser policy */
    } finally {
      unlockFsSoon();
    }
  }

  async function toggleMonitorFullscreen() {
    const mon = monitorRef.current;
    if (!mon) return;
    try {
      if (getFullscreenElement() === mon) {
        fsLockRef.current = true;
        await exitDocumentFullscreen();
        unlockFsSoon();
      } else {
        await enterMonitorFullscreen();
      }
    } catch {
      fsLockRef.current = false;
    }
    requestAnimationFrame(() => {
      measureVideoBox();
      requestAnimationFrame(measureVideoBox);
    });
  }

  useEffect(() => {
    measureVideoBox();
    const v = videoRef.current;
    const mon = monitorRef.current;
    if (!v) return undefined;
    const onMeta = () => measureVideoBox();
    const remesureSoon = () => {
      requestAnimationFrame(() => {
        measureVideoBox();
        requestAnimationFrame(measureVideoBox);
      });
    };

    const syncFsState = () => {
      const fs = getFullscreenElement();
      setMonitorFullscreen(!!(mon && fs === mon));
      remesureSoon();
    };

    /**
     * Native <video> fullscreen hides the caption plate. We hide that
     * control (controlsList=nofullscreen) and, if it still happens,
     * promote to .monitor — never exit+reenter in the same tick (bounce).
     */
    const onFsChange = () => {
      const fs = getFullscreenElement();
      setMonitorFullscreen(!!(mon && fs === mon));
      if (!fsLockRef.current && mon && fs === v) {
        void enterMonitorFullscreen();
      }
      remesureSoon();
    };

    const onPresentation = () => {
      if (fsLockRef.current) return;
      if (v.webkitPresentationMode === "fullscreen") {
        void enterMonitorFullscreen();
      }
    };

    v.addEventListener("loadedmetadata", onMeta);
    window.addEventListener("resize", measureVideoBox);
    document.addEventListener("fullscreenchange", onFsChange);
    document.addEventListener("webkitfullscreenchange", onFsChange);
    v.addEventListener("webkitpresentationmodechanged", onPresentation);

    let ro;
    if (mon && typeof ResizeObserver !== "undefined") {
      ro = new ResizeObserver(() => measureVideoBox());
      ro.observe(mon);
    }

    syncFsState();

    return () => {
      v.removeEventListener("loadedmetadata", onMeta);
      window.removeEventListener("resize", measureVideoBox);
      document.removeEventListener("fullscreenchange", onFsChange);
      document.removeEventListener("webkitfullscreenchange", onFsChange);
      v.removeEventListener("webkitpresentationmodechanged", onPresentation);
      if (ro) ro.disconnect();
    };
  }, [measureVideoBox, source?.id, source?.video_path, source?.status]);

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
          // Only recover library text that already matches the thread + 04-summary era.
          // Older URL-only prompts would otherwise clobber the new default.
          const fromLib = (list || []).find((s) => {
            const t = (s.clip_prompt_text || "").trim();
            if (!t) return false;
            const lower = t.toLowerCase();
            return (
              lower.includes("04-summary") ||
              (lower.includes("thread") && lower.includes("opener"))
            );
          });
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
    setImportNotice(null);
    setTimingInfoOpen(false);
  }, [selectedId]);

  // Export success/progress is per-clip — clear when switching clips so the next
  // clip doesn't inherit a stale "Export success" box.
  useEffect(() => {
    setExportMsg(null);
    setExportPercent(null);
    setExportPath(null);
    setExportStatusOpen(false);
    setExportFailed(false);
  }, [activeClipId]);

  useEffect(() => {
    if (selectedId) {
      loadSource(selectedId)
        .then((s) => {
          setError(null);
          resumeAgentIfNeeded(s);
        })
        .catch((e) => setError(String(e.message || e)));
    }
  }, [selectedId, loadSource, resumeAgentIfNeeded]);

  // Landing step follows saved progress so leaving Agent (or remounting) does
  // not dump you back on Opener with Writer locked.
  useEffect(() => {
    setAgentStep(inferAgentStep(source));
  }, [source?.id]);

  // True when any source is mid-pipeline (drives list poll key without thrashing on job %).
  const hasInflightSource = useMemo(
    () =>
      sources.some((s) =>
        ["pending", "downloading", "transcribing"].includes(s.status)
      ),
    // Only recompute when a status string set changes, not on every job tick
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [sources.map((s) => `${s.id}:${s.status}`).join("|")]
  );

  // Poll job progress while ingest/STT runs.
  // Depend on id + status only — NOT the whole `source` object — otherwise every
  // loadSource() resets the interval and the sidebar never gets steady ticks.
  useEffect(() => {
    if (!hasInflightSource) {
      // Last inflight source just finished — one more load so the paper wakes.
      if (selectedId && selectedWasInflightRef.current) {
        selectedWasInflightRef.current = false;
        void loadSource(selectedId);
      }
      return undefined;
    }
    let cancelled = false;
    const inflight = (status) =>
      ["pending", "downloading", "transcribing"].includes(status);
    const tick = async () => {
      try {
        // Always refresh the list so sidebar % / elapsed move for every inflight source
        // (including when you're viewing a different source).
        const list = await api.listSources();
        if (cancelled) return;
        setSources(list);
        setError(null);
        const selected = selectedId;
        if (!selected) return;
        const row = list.find((s) => s.id === selected);
        const rowBusy = !!(row && inflight(row.status));
        // Reload while busy, and once more when this open video leaves busy
        // (sidebar list updates; the paper used to skip that last fetch).
        if (rowBusy || selectedWasInflightRef.current) {
          await loadSource(selected);
        }
        selectedWasInflightRef.current = rowBusy;
      } catch (e) {
        if (cancelled) return;
        const msg = String(e.message || e);
        if (/internal server error|failed to fetch|network/i.test(msg)) return;
        setError(msg);
      }
    };
    tick(); // immediate paint
    const t = setInterval(tick, 1000);
    return () => {
      cancelled = true;
      clearInterval(t);
    };
  }, [hasInflightSource, selectedId, loadSource]);

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
    if (captionFocusedRef.current) return;
    captionsDraftRef.current = activeClip?.captions || null;
  }, [activeClip?.id, activeClip?.captions]);

  // Keep clip title draft in sync with server/active clip, but not while the field is focused.
  useEffect(() => {
    if (clipTitleFocusedRef.current) return;
    const t = activeClip?.title || "";
    setClipTitleDraft(t);
    clipTitleSavedRef.current = t;
  }, [activeClip?.id, activeClip?.title]);

  // Keep post draft in sync when not focused. Owner stays the clip the
  // draft was typed for — do not retarget mid-keystroke or blur saves
  // the old text onto the newly selected clip.
  useEffect(() => {
    if (postFocusedRef.current) return;
    postOwnerRef.current = {
      sourceId: source?.id || null,
      clipId: activeClip?.id || null,
      tags: activeClip?.tags || [],
    };
    const t = activeClip?.post_text || "";
    setPostDraft(t);
    postSavedRef.current = t;
  }, [source?.id, activeClip?.id, activeClip?.post_text, activeClip?.tags]);

  useEffect(() => {
    if (editingTitle && titleInputRef.current) titleInputRef.current.focus();
  }, [editingTitle]);

  // Newest ingest first (created_at), regardless of ready vs downloading.
  const sortedSources = useMemo(() => {
    return [...sources].sort((a, b) => {
      const ta = String(a.created_at || a.updated_at || "");
      const tb = String(b.created_at || b.updated_at || "");
      return tb.localeCompare(ta);
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

  /**
   * Place margin in/out/playhead from real transcript line boxes.
   * Time-linear % was wrong: segments have unequal duration and line height.
   */
  useLayoutEffect(() => {
    const grid = paperGridRef.current;
    if (!grid || !activeClip || !segments.length) {
      setMarginMarks(null);
      return undefined;
    }

    const relY = (el, edge = "top") => {
      const gr = grid.getBoundingClientRect();
      const er = el.getBoundingClientRect();
      return edge === "bottom" ? er.bottom - gr.top : er.top - gr.top;
    };

    const measure = () => {
      let firstIn = -1;
      let lastIn = -1;
      for (let i = 0; i < segments.length; i++) {
        const seg = segments[i];
        const end = seg.end ?? seg.start + 0.01;
        if (seg.start < activeClip.t_out && end > activeClip.t_in) {
          if (firstIn < 0) firstIn = i;
          lastIn = i;
        }
      }

      // No overlap (empty range) — pin to nearest lines by t_in / t_out
      if (firstIn < 0) {
        for (let i = 0; i < segments.length; i++) {
          if (segments[i].start >= activeClip.t_in) {
            firstIn = i;
            break;
          }
          firstIn = i;
        }
        lastIn = firstIn;
        for (let i = segments.length - 1; i >= 0; i--) {
          if ((segments[i].end ?? segments[i].start) <= activeClip.t_out) {
            lastIn = i;
            break;
          }
        }
        if (lastIn < firstIn) lastIn = firstIn;
      }

      const firstEl = document.getElementById(`seg-${firstIn}`);
      const lastEl = document.getElementById(`seg-${lastIn}`);
      if (!firstEl || !lastEl) {
        setMarginMarks(null);
        return;
      }

      const inTop = relY(firstEl, "top");
      const outBot = relY(lastEl, "bottom");
      let phTop = inTop + 4;
      if (activeSegIndex >= 0) {
        const phEl = document.getElementById(`seg-${activeSegIndex}`);
        if (phEl) {
          phTop = relY(phEl, "top") + phEl.getBoundingClientRect().height * 0.35;
        }
      }

      setMarginMarks({
        inTop,
        outTop: outBot - 2,
        height: Math.max(2, outBot - inTop),
        phTop,
      });
    };

    measure();
    const ro =
      typeof ResizeObserver !== "undefined"
        ? new ResizeObserver(() => measure())
        : null;
    if (ro) ro.observe(grid);
    window.addEventListener("resize", measure);
    return () => {
      if (ro) ro.disconnect();
      window.removeEventListener("resize", measure);
    };
  }, [
    activeClip?.id,
    activeClip?.t_in,
    activeClip?.t_out,
    segments,
    activeSegIndex,
    source?.id,
  ]);

  // New source → next scroll is always a "jump" (pin near top).
  // Do not key on transcript object identity — loadSource polls and re-sets it.
  useEffect(() => {
    prevSegIndexRef.current = -1;
  }, [selectedId]);

  function findSegIndexAtTime(t) {
    if (!segments.length) return -1;
    const exact = segments.findIndex(
      (s) => t >= s.start && t < (s.end || s.start + 0.01)
    );
    if (exact >= 0) return exact;
    let best = -1;
    for (let i = 0; i < segments.length; i++) {
      if (segments[i].start <= t) best = i;
      else break;
    }
    return best;
  }

  /** Pin a transcript line near the top of the paper body. */
  function scrollTranscriptToSegIndex(idx, behavior = "smooth") {
    if (idx < 0) return;
    const el = document.getElementById(`seg-${idx}`);
    if (!el) return;
    prevSegIndexRef.current = idx;
    const container = el.closest(".paper__body");
    if (container) {
      const pad = 12;
      const top =
        el.getBoundingClientRect().top -
        container.getBoundingClientRect().top +
        container.scrollTop -
        pad;
      container.scrollTo({ top: Math.max(0, top), behavior });
      return;
    }
    el.scrollIntoView({ block: "start", behavior });
  }

  /**
   * Sidebar clip select: seek player to t_in, show Transcript, scroll to clip start.
   * Works even if the clip is already active / video is playing mid-range.
   */
  function selectClip(c) {
    if (!c) return;
    flushPostIfDirty();
    captionFocusedRef.current = false;
    setActiveClipId(c.id);
    seekTo(c.t_in);
    forceTranscriptJumpRef.current = true;
    setPaneTab("transcript");
    // Wait for tab/transcript DOM, then pin the in-line at the top.
    requestAnimationFrame(() => {
      requestAnimationFrame(() => {
        const idx = findSegIndexAtTime(c.t_in);
        scrollTranscriptToSegIndex(idx);
        forceTranscriptJumpRef.current = false;
      });
    });
  }

  useEffect(() => {
    if (activeSegIndex < 0) {
      prevSegIndexRef.current = -1;
      return;
    }
    const el = document.getElementById(`seg-${activeSegIndex}`);
    if (!el) return;

    const prev = prevSegIndexRef.current;
    prevSegIndexRef.current = activeSegIndex;
    // Clip click / Apply / big seek → pin line near top. Adjacent playhead steps → nudge only.
    const jumped =
      forceTranscriptJumpRef.current ||
      prev < 0 ||
      Math.abs(activeSegIndex - prev) > 1;

    if (jumped) {
      const container = el.closest(".paper__body");
      if (container) {
        const pad = 12;
        const top =
          el.getBoundingClientRect().top -
          container.getBoundingClientRect().top +
          container.scrollTop -
          pad;
        container.scrollTo({ top: Math.max(0, top), behavior: "smooth" });
        return;
      }
      el.scrollIntoView({ block: "start", behavior: "smooth" });
      return;
    }

    el.scrollIntoView({ block: "nearest", behavior: "smooth" });
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
        `Remove “${label}” from the sidebar?\n\nCancels download, transcribe, export, and publish for this source. Files on disk are kept.`
      )
    ) {
      return;
    }
    try {
      await api.deleteSource(id);
      setAgentUi((prev) => {
        if (!prev[id]) return prev;
        const next = { ...prev };
        delete next[id];
        return next;
      });
      if (selectedId === id) {
        setSelectedId(null);
        setSource(null);
        setTranscript(null);
        setActiveClipId(null);
        setExportBusy(false);
        setPublishBusy(false);
        setPublishPreview(null);
        setCaptionJobState(null);
      }
      await refreshList();
    } catch (err) {
      setError(String(err.message || err));
    }
  }

  async function rebuildAudio() {
    if (!source || retryBusy) return;
    setError(null);
    setRetryBusy(true);
    setSource((prev) =>
      prev
        ? {
            ...prev,
            status: "downloading",
            error: null,
            job: {
              ...(prev.job || {}),
              stage: "downloading",
              progress_kind: "measured",
              message: "Rebuilding audio (ffmpeg HLS)…",
              percent: 10,
            },
          }
        : prev
    );
    try {
      await api.rebuildAudio(source.id);
      await loadSource(source.id);
    } catch (err) {
      setError(String(err.message || err));
    } finally {
      setRetryBusy(false);
    }
  }

  async function retryDownload() {
    if (!source || retryBusy) return;
    setError(null);
    setRetryBusy(true);
    setSource((prev) =>
      prev
        ? {
            ...prev,
            status: "downloading",
            error: null,
            job: {
              ...(prev.job || {}),
              stage: "queued",
              progress_kind: "measured",
              message: "Retrying download…",
              percent: 0,
            },
          }
        : prev
    );
    try {
      await api.retryDownload(source.id, model);
      await loadSource(source.id);
    } catch (err) {
      setError(String(err.message || err));
    } finally {
      setRetryBusy(false);
    }
  }

  async function retryTranscribe() {
    if (!source || retryBusy) return;
    setError(null);
    setRetryBusy(true);
    // Optimistic paint so the pipeline UI appears without a full page refresh
    setSource((prev) =>
      prev
        ? {
            ...prev,
            status: "transcribing",
            error: null,
            model: model || prev.model,
            job: {
              ...(prev.job || {}),
              stages: DEFAULT_STAGES,
              stage: "transcribing",
              progress_kind: "indeterminate",
              message: `Transcribing with Whisper (${model})… preparing`,
              detail: "Retry — using existing download",
              elapsed_s: 0,
              percent: undefined,
            },
          }
        : prev
    );
    setSources((list) =>
      list.map((s) =>
        s.id === source.id
          ? { ...s, status: "transcribing", error: null, model: model || s.model }
          : s
      )
    );
    try {
      const updated = await api.retryTranscribe(source.id, model);
      if (updated && updated.id) {
        setSource((prev) => ({
          ...(prev || {}),
          ...updated,
          job: updated.job || prev?.job,
        }));
      }
      await loadSource(source.id);
      await refreshList();
    } catch (err) {
      setError(String(err.message || err));
      // Re-sync so we don't stay stuck on optimistic "transcribing"
      try {
        await loadSource(source.id);
        await refreshList();
      } catch {
        /* ignore */
      }
    } finally {
      setRetryBusy(false);
    }
  }

  async function saveClipPatch(patch) {
    if (!source || !activeClip) return;
    try {
      const updated = await api.updateClip(source.id, activeClip.id, patch);
      // Merge the patched clip instead of full loadSource — avoids wiping other
      // in-progress local edits (clip title draft, post text, captions).
      setSource((prev) => {
        if (!prev) return prev;
        return {
          ...prev,
          clips: (prev.clips || []).map((c) => {
            if (c.id !== updated.id) return c;
            const merged = { ...c, ...updated };
            // Keep in-progress fields if focused (server may be stale).
            if (c.id === activeClipIdRef.current) {
              if (clipTitleFocusedRef.current) {
                merged.title = clipTitleDraftRef.current;
              }
              if (postFocusedRef.current) {
                merged.post_text = postDraftRef.current;
              }
            }
            return merged;
          }),
        };
      });
      if (typeof patch.title === "string" && !clipTitleFocusedRef.current) {
        setClipTitleDraft(updated.title || "");
        clipTitleSavedRef.current = updated.title || "";
      }
      if (typeof patch.post_text === "string" && !postFocusedRef.current) {
        setPostDraft(updated.post_text || "");
        postSavedRef.current = updated.post_text || "";
      }
      await refreshList();
    } catch (err) {
      setError(String(err.message || err));
    }
  }

  async function commitClipTitle() {
    if (!source || !activeClip) return;
    const next = clipTitleDraft;
    // Compare to last *saved* title, not live source (we optimistically update source while typing).
    if (next === clipTitleSavedRef.current) return;
    try {
      const updated = await api.updateClip(source.id, activeClip.id, {
        title: next,
      });
      clipTitleSavedRef.current = updated.title || next;
      setClipTitleDraft(updated.title || next);
      setSource((prev) => {
        if (!prev) return prev;
        return {
          ...prev,
          clips: (prev.clips || []).map((c) =>
            c.id === updated.id ? { ...c, ...updated } : c
          ),
        };
      });
      await refreshList();
    } catch (err) {
      setError(String(err.message || err));
    }
  }

  /**
   * Persist post_text for the draft's owner clip.
   * Uses refs so blur still saves correctly if React state has already switched clips.
   */
  async function commitPostText(rawText) {
    const owner = postOwnerRef.current;
    if (!owner.sourceId || !owner.clipId) return;
    // Save exactly what the user wrote — do not append @handles.
    const next = rawText != null ? String(rawText) : postDraftRef.current;
    if (next === postSavedRef.current) return;
    try {
      const updated = await api.updateClip(owner.sourceId, owner.clipId, {
        post_text: next,
      });
      postSavedRef.current = updated.post_text ?? next;
      // Only write draft back if still on the same clip
      if (activeClipIdRef.current === owner.clipId) {
        setPostDraft(postSavedRef.current);
      }
      setSource((prev) => {
        if (!prev || prev.id !== owner.sourceId) return prev;
        return {
          ...prev,
          clips: (prev.clips || []).map((c) => {
            if (c.id !== owner.clipId) return c;
            const merged = { ...c, ...updated };
            // Don't clobber a different field still being edited
            if (
              clipTitleFocusedRef.current &&
              c.id === activeClipIdRef.current
            ) {
              merged.title = clipTitleDraftRef.current;
            }
            return merged;
          }),
        };
      });
    } catch (err) {
      setError(String(err.message || err));
    }
  }

  /** Fire-and-forget save before navigation if the post field has unsaved edits. */
  function flushPostIfDirty() {
    postFocusedRef.current = false;
    const owner = postOwnerRef.current;
    if (!owner.sourceId || !owner.clipId) return;
    if (postDraftRef.current === postSavedRef.current) return;
    void commitPostText(postDraftRef.current);
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

  async function saveSummaryText() {
    if (!source) return;
    try {
      const updated = await api.updateSource(source.id, {
        summary_post_text: summaryTextDraft,
      });
      setSource((prev) => ({ ...prev, ...updated }));
      setSummaryTextDraft(updated.summary_post_text || summaryTextDraft);
    } catch (err) {
      setError(String(err.message || err));
    }
  }

  function showAgentError(sourceId, err) {
    if (selectedIdRef.current === sourceId) {
      setError(String(err?.message || err));
    }
  }

  async function runSummaryAgent(opts = {}) {
    const sourceId = source?.id;
    if (!sourceId || isSourceBusy(sourceId)) return;
    setError(null);
    patchAgentUi(sourceId, {
      busy: true,
      step: "summary",
      msg: opts.notes ? "Revising opener…" : "Drafting thread opener…",
      startedAt: Date.now(),
    });
    try {
      const started = await api.runSummaryAgent(sourceId, opts);
      const jobId = started.job_id;
      if (!jobId) throw new Error("summary job did not start");
      const job = await watchAgentJob(sourceId, jobId, { step: "summary" });
      if (!job) return;
      if (job.status === "error") {
        throw new Error(job.error || job.message || "summary agent failed");
      }
      if (job.text && selectedIdRef.current === sourceId) {
        setSummaryTextDraft(job.text);
      }
      await loadSource(sourceId);
      patchAgentUi(sourceId, {
        msg: "Opener ready. Edit, send notes, or approve.",
      });
    } catch (err) {
      showAgentError(sourceId, err);
      patchAgentUi(sourceId, { msg: null });
      try {
        await loadSource(sourceId);
      } catch {
        /* keep the job error even if refresh fails */
      }
    }
  }

  async function approveSummaryOpener() {
    const sourceId = source?.id;
    if (!sourceId || !summaryTextDraft.trim()) return false;
    if (isSourceBusy(sourceId)) return false;
    setError(null);
    patchAgentUi(sourceId, { busy: true, step: "summary" });
    try {
      const updated = await api.approveSummary(sourceId, summaryTextDraft);
      applySourceUpdate(sourceId, updated);
      const clipsJobId = updated.clips_job_id;
      if (clipsJobId) {
        patchAgentUi(sourceId, {
          step: "clips",
          msg: "Finding moments…",
          startedAt: Date.now(),
        });
        if (selectedIdRef.current === sourceId) setAgentStep("clips");
        const job = await watchAgentJob(sourceId, clipsJobId, { step: "clips" });
        if (!job) return true;
        await loadSource(sourceId);
        if (job.status === "error") {
          throw new Error(job.error || job.message || "clip identifier failed");
        }
        patchAgentUi(sourceId, { msg: job.message || "Cut ready." });
      } else {
        patchAgentUi(sourceId, { msg: "Opener approved." });
      }
      return true;
    } catch (err) {
      showAgentError(sourceId, err);
      return false;
    } finally {
      patchAgentUi(sourceId, { busy: false });
    }
  }

  async function runClipsAgent(opts = {}) {
    const sourceId = source?.id;
    if (!sourceId || isSourceBusy(sourceId)) return;
    setError(null);
    patchAgentUi(sourceId, {
      busy: true,
      step: "clips",
      msg: opts.notes ? "Revising the cut…" : "Finding moments…",
      startedAt: Date.now(),
    });
    try {
      const started = await api.runClipsAgent(sourceId, opts);
      const jobId = started.job_id;
      if (!jobId) throw new Error("clip job did not start");
      const job = await watchAgentJob(sourceId, jobId, { step: "clips" });
      if (!job) return;
      if (job.status === "error") {
        throw new Error(job.error || job.message || "clip identifier failed");
      }
      await loadSource(sourceId);
      patchAgentUi(sourceId, { msg: job.message || "Cut ready." });
    } catch (err) {
      showAgentError(sourceId, err);
    }
  }

  async function approveClipsCut() {
    const sourceId = source?.id;
    if (!sourceId) return false;
    if (isSourceBusy(sourceId)) return false;
    setError(null);
    if (selectedIdRef.current === sourceId) setAgentStep("writer");
    patchAgentUi(sourceId, {
      busy: true,
      step: "writer",
      msg: "Writing posts…",
      startedAt: Date.now(),
    });
    try {
      const updated = await api.approveClips(sourceId);
      applySourceUpdate(sourceId, updated);
      if (updated.writer_error && !updated.writer_job_id) {
        showAgentError(sourceId, updated.writer_error);
        patchAgentUi(sourceId, {
          msg: "Clips approved. Hit Write posts when ready.",
        });
        return true;
      }
      const writerJobId = updated.writer_job_id;
      if (writerJobId) {
        let lastFilled = 0;
        let lastWriting = 0;
        const job = await watchAgentJob(sourceId, writerJobId, {
          step: "writer",
          onTick: (j) => {
            const n = (j.posts || []).filter((p) =>
              String(p?.post_text || "").trim()
            ).length;
            const writing = Number(j.writing_clip) || 0;
            if (n > lastFilled || writing !== lastWriting) {
              lastFilled = n;
              lastWriting = writing;
              void loadSource(sourceId);
            }
          },
        });
        if (!job) return true;
        await loadSource(sourceId);
        if (job.status === "error") {
          showAgentError(sourceId, job.error || job.message || "writer failed");
          patchAgentUi(sourceId, {
            msg: job.message || "Writer failed. Try Write posts.",
          });
          return true;
        }
        patchAgentUi(sourceId, { msg: job.message || "Posts ready." });
      } else {
        patchAgentUi(sourceId, {
          msg: "Clips approved. Hit Write posts when ready.",
        });
      }
      return true;
    } catch (err) {
      showAgentError(sourceId, err);
      return false;
    } finally {
      patchAgentUi(sourceId, { busy: false });
    }
  }

  async function saveWriterPatch(body) {
    const sourceId = source?.id;
    if (!sourceId || isSourceBusy(sourceId)) return;
    try {
      const updated = await api.patchWriter(sourceId, body);
      applySourceUpdate(sourceId, updated);
    } catch (err) {
      if (!/writer is running/i.test(String(err.message || err))) {
        showAgentError(sourceId, err);
      }
    }
  }

  function saveWriterPost(tIn, postText) {
    return saveWriterPatch({ t_in: tIn, post_text: postText });
  }

  function saveWriterFeedback(drafts) {
    return saveWriterPatch({ feedback_drafts: drafts || {} });
  }

  function saveWriterBundle(body) {
    return saveWriterPatch(body);
  }

  async function runWriterAgent(opts = {}) {
    const sourceId = source?.id;
    if (!sourceId || isSourceBusy(sourceId)) return;
    setError(null);
    patchAgentUi(sourceId, {
      busy: true,
      step: "writer",
      msg: opts.notes ? "Revising posts…" : "Writing posts…",
      startedAt: Date.now(),
    });
    try {
      const started = await api.runWriterAgent(sourceId, opts);
      const jobId = started.job_id;
      if (!jobId) throw new Error("writer job did not start");
      let lastFilled = 0;
      let lastWriting = 0;
      const job = await watchAgentJob(sourceId, jobId, {
        step: "writer",
        onTick: (j) => {
          const n = (j.posts || []).filter((p) =>
            String(p?.post_text || "").trim()
          ).length;
          const writing = Number(j.writing_clip) || 0;
          if (n > lastFilled || writing !== lastWriting) {
            lastFilled = n;
            lastWriting = writing;
            void loadSource(sourceId);
          }
        },
      });
      if (!job) return;
      if (job.status === "error") {
        throw new Error(job.error || job.message || "writer failed");
      }
      await loadSource(sourceId);
      patchAgentUi(sourceId, { msg: job.message || "Posts ready." });
    } catch (err) {
      showAgentError(sourceId, err);
    }
  }

  async function pollCaptionsJob(sourceId, jobId) {
    patchAgentUi(sourceId, {
      busy: true,
      step: "captions",
      msg: "Creating clips…",
      percent: 0,
      startedAt: Date.now(),
    });
    const job = await watchAgentJob(sourceId, jobId, {
      step: "captions",
      onTick: (tick) => {
        if (!Array.isArray(tick.items) || selectedIdRef.current !== sourceId) return;
        setSource((prev) => {
          if (!prev || prev.id !== sourceId) return prev;
          const run = { ...(prev.agent_run || {}) };
          run.captions = {
            ...(run.captions || {}),
            items: tick.items,
            status: "running",
          };
          return { ...prev, agent_run: run };
        });
      },
    });
    if (!job) return false;
    await loadSource(sourceId);
    if (job.status === "error") {
      showAgentError(sourceId, job.error || job.message || "clip package failed");
      patchAgentUi(sourceId, {
        msg: job.message || "Clip package failed. Try Run again.",
      });
      return false;
    }
    patchAgentUi(sourceId, { msg: job.message || "Clips ready.", percent: 100 });
    return true;
  }

  async function pollReplyJob(sourceId, jobId) {
    const job = await watchAgentJob(sourceId, jobId, { lock: "reply", step: "reply" });
    if (!job) return false;
    await loadSource(sourceId);
    if (job.status === "error") {
      showAgentError(sourceId, job.error || job.message || "reply failed");
      return false;
    }
    return true;
  }

  async function approveWriterPosts() {
    const sourceId = source?.id;
    if (!sourceId) return false;
    if (isSourceBusy(sourceId)) return false;
    setError(null);
    if (selectedIdRef.current === sourceId) setAgentStep("captions");
    patchAgentUi(sourceId, {
      busy: true,
      step: "captions",
      msg: "Creating clips…",
      startedAt: Date.now(),
    });
    try {
      const updated = await api.approveWriter(sourceId);
      applySourceUpdate(sourceId, updated);
      if (updated.captions_error && !updated.captions_job_id) {
        showAgentError(sourceId, updated.captions_error);
        patchAgentUi(sourceId, {
          msg: "Posts approved. Hit Run caption package.",
        });
        return true;
      }
      if (updated.reply_job_id) {
        void pollReplyJob(sourceId, updated.reply_job_id);
      }
      if (updated.captions_job_id) {
        await pollCaptionsJob(sourceId, updated.captions_job_id);
      } else {
        patchAgentUi(sourceId, {
          msg: "Posts approved. Run the clip package if it did not start.",
        });
      }
      return true;
    } catch (err) {
      showAgentError(sourceId, err);
      return false;
    } finally {
      patchAgentUi(sourceId, { busy: false, percent: null });
    }
  }

  async function runCaptionsAgent() {
    const sourceId = source?.id;
    if (!sourceId || isSourceBusy(sourceId)) return;
    setError(null);
    if (selectedIdRef.current === sourceId) setAgentStep("captions");
    try {
      const started = await api.runCaptionsAgent(sourceId);
      if (!started.job_id) throw new Error("caption job did not start");
      await pollCaptionsJob(sourceId, started.job_id);
    } catch (err) {
      showAgentError(sourceId, err);
      patchAgentUi(sourceId, { busy: false, percent: null });
    }
  }

  async function runReplyAgent(opts = {}) {
    const sourceId = source?.id;
    if (!sourceId || isSourceReplyBusy(sourceId)) return;
    setError(null);
    try {
      const started = await api.runReplyAgent(sourceId, {
        notes: opts.notes,
        currentDraft: opts.currentDraft,
      });
      if (!started.job_id) throw new Error("reply job did not start");
      await pollReplyJob(sourceId, started.job_id);
    } catch (err) {
      showAgentError(sourceId, err);
      patchAgentUi(sourceId, { replyBusy: false });
    }
  }

  async function saveReplyPost(textOrBody) {
    const sourceId = source?.id;
    if (!sourceId || isSourceReplyBusy(sourceId)) return;
    try {
      const body =
        typeof textOrBody === "string" ? { post_text: textOrBody } : textOrBody;
      const updated = await api.patchReply(sourceId, body);
      applySourceUpdate(sourceId, updated);
    } catch (err) {
      showAgentError(sourceId, err);
    }
  }

  async function exportSummaryPackage() {
    const sourceId = source?.id;
    if (!sourceId || isSourceBusy(sourceId)) return;
    setError(null);
    patchAgentUi(sourceId, {
      busy: true,
      step: "summary",
      msg: "Exporting summary package…",
    });
    try {
      if (summaryPromptDraft !== (source.summary_prompt_text || "")) {
        await saveSummaryPrompt();
      }
      const result = await api.exportSummaryPackage(sourceId);
      patchAgentUi(sourceId, {
        msg: `Summary package ready\n${result.dir}\nDrag into your Summary LLM project.`,
      });
      try {
        await api.revealPath(result.dir);
      } catch {
        /* best-effort */
      }
    } catch (err) {
      showAgentError(sourceId, err);
      patchAgentUi(sourceId, { msg: null, step: null });
    } finally {
      patchAgentUi(sourceId, { busy: false });
    }
  }

  async function exportClipPackage() {
    const sourceId = source?.id;
    if (!sourceId || isSourceBusy(sourceId)) return;
    setError(null);
    patchAgentUi(sourceId, {
      busy: true,
      step: "clip",
      msg: "Exporting clip package…",
    });
    try {
      if (summaryTextDraft !== (source.summary_post_text || "")) {
        await saveSummaryText();
      }
      if (clipPromptDraft !== (source.clip_prompt_text || "")) {
        await saveClipPrompt();
      }
      if (!summaryTextDraft.trim() && !(source.summary_post_text || "").trim()) {
        setError(
          "Paste the Summary agent output before exporting the clip package"
        );
        patchAgentUi(sourceId, { busy: false, msg: null, step: null });
        return;
      }
      const result = await api.exportClipPackage(sourceId);
      patchAgentUi(sourceId, {
        msg: `Clip package ready\n${result.dir}\nDrag into your Clipping LLM project.`,
      });
      try {
        await api.revealPath(result.dir);
      } catch {
        /* best-effort */
      }
    } catch (err) {
      showAgentError(sourceId, err);
      patchAgentUi(sourceId, { msg: null, step: null });
    } finally {
      patchAgentUi(sourceId, { busy: false });
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
    if (source.id) {
      patchAgentUi(source.id, { step: "import", msg: "Importing clip plan…" });
    }
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
      if (source.id) patchAgentUi(source.id, { msg: null, step: null });
      setImportNotice(notice);
      if (result.clips?.[0]?.id) {
        setActiveClipId(result.clips[0].id);
        const tin = result.clips[0].t_in;
        if (typeof tin === "number") seekTo(tin);
      }
      setPaneTab("transcript");
    } catch (err) {
      setError(String(err.message || err));
      if (source.id) patchAgentUi(source.id, { msg: null, step: null });
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

  function setCaptionJobState(next) {
    captionJobRef.current = next;
    setCaptionJob(next);
  }

  function captionReadyMessage(clip) {
    const n = clip?.captions?.length || 0;
    const meta = clip?.captions_meta || {};
    return (
      `Captions ready — ${n} line(s)` +
      (meta.cleaned
        ? " · names cleaned"
        : meta.clean_error === "no_key"
          ? " · add XAI_API_KEY to clean names"
          : meta.clean_error
            ? ` · clean skipped (${meta.clean_error})`
            : "")
    );
  }

  function applyClipCaptionUpdate(ownerId, clipId, clip) {
    if (!clip) return;
    if (selectedIdRef.current === ownerId && activeClipIdRef.current === clipId) {
      if (!captionFocusedRef.current) {
        captionsDraftRef.current = clip.captions || captionsDraftRef.current;
      }
    }
    if (selectedIdRef.current === ownerId) {
      setSource((prev) => {
        if (!prev || prev.id !== ownerId) return prev;
        return {
          ...prev,
          clips: (prev.clips || []).map((c) =>
            c.id === clipId
              ? captionFocusedRef.current && c.id === activeClipIdRef.current
                ? {
                    ...c,
                    captions: captionsDraftRef.current ?? c.captions,
                    captions_meta: clip.captions_meta ?? c.captions_meta,
                  }
                : { ...c, ...clip }
              : c
          ),
        };
      });
    }
  }

  async function pollCaptionClean(ownerId, clipId) {
    const t0 = Date.now();
    let last = null;
    while (Date.now() - t0 < 100000) {
      await sleep(800);
      const job = captionJobRef.current;
      if (!job || job.sourceId !== ownerId || job.clipId !== clipId) return;
      try {
        const s = await api.getSource(ownerId);
        last = (s.clips || []).find((c) => c.id === clipId) || last;
        if (last && !last.captions_meta?.cleaning) {
          applyClipCaptionUpdate(ownerId, clipId, last);
          if (
            captionJobRef.current?.sourceId === ownerId &&
            captionJobRef.current?.clipId === clipId
          ) {
            setCaptionJobState(null);
            if (selectedIdRef.current === ownerId) {
              setCaptionsMsg(captionReadyMessage(last));
            }
          }
          return;
        }
      } catch {
        /* keep polling */
      }
    }
    if (
      captionJobRef.current?.sourceId === ownerId &&
      captionJobRef.current?.clipId === clipId
    ) {
      setCaptionJobState(null);
      if (selectedIdRef.current === ownerId) {
        setCaptionsMsg(
          captionReadyMessage(last) ||
            "Captions ready. Name clean is taking longer in the background."
        );
      }
    }
  }

  async function persistInOutForGenerate() {
    if (!activeClip) return;
    const t_in = parseTsInput(inDraft);
    const t_out = parseTsInput(outDraft);
    if (t_in == null || t_out == null || t_out <= t_in) return;
    const same =
      Math.abs(t_in - Number(activeClip.t_in || 0)) < 0.05 &&
      Math.abs(t_out - Number(activeClip.t_out || 0)) < 0.05;
    if (same) return;
    await saveClipPatch({ t_in, t_out });
  }

  async function generateCaptions() {
    if (!source || !activeClip) return;
    await persistInOutForGenerate();
    const clipId = activeClip.id;
    const ownerId = source.id;
    const cur = captionJobRef.current;
    if (cur?.sourceId === ownerId && cur?.clipId === clipId && cur.phase === "slicing") {
      return;
    }
    setError(null);
    setCaptionJobState({ sourceId: ownerId, clipId, phase: "slicing" });
    setCaptionsMsg("Slicing transcript…");
    try {
      const updated = await api.generateCaptions(ownerId, clipId);
      applyClipCaptionUpdate(ownerId, clipId, updated);
      if (selectedIdRef.current === ownerId) setPaneTab("captions");
      const cleaning = !!updated.captions_meta?.cleaning;
      if (cleaning) {
        setCaptionJobState({ sourceId: ownerId, clipId, phase: "cleaning" });
        if (selectedIdRef.current === ownerId) {
          setCaptionsMsg(
            `Captions ready — ${updated.captions?.length || 0} line(s). Cleaning names…`
          );
        }
        void pollCaptionClean(ownerId, clipId);
      } else {
        setCaptionJobState(null);
        if (selectedIdRef.current === ownerId) {
          setCaptionsMsg(captionReadyMessage(updated));
        }
      }
    } catch (err) {
      setCaptionJobState(null);
      if (selectedIdRef.current === ownerId) {
        setError(String(err.message || err));
      }
    }
  }

  async function persistCaptions() {
    if (!source || !activeClip) return;
    const cues = captionsDraftRef.current ?? activeClip.captions ?? [];
    try {
      const updated = await api.saveCaptions(source.id, activeClip.id, cues);
      setSource((prev) => {
        if (!prev) return prev;
        return {
          ...prev,
          clips: (prev.clips || []).map((c) => {
            if (c.id !== updated.id) return c;
            if (captionFocusedRef.current) {
              return {
                ...c,
                captions: captionsDraftRef.current ?? c.captions,
                captions_meta: updated.captions_meta ?? c.captions_meta,
              };
            }
            return { ...c, ...updated };
          }),
        };
      });
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
      // Flush caption text edits so burn-in matches the monitor preview.
      const clipsToFlush = (source.clips || []).filter((c) => {
        if (!clipIds) return true;
        return clipIds.includes(c.id);
      });
      for (const c of clipsToFlush) {
        const cues =
          c.id === activeClipIdRef.current
            ? captionsDraftRef.current ?? c.captions
            : c.captions;
        if (!(cues || []).length) continue;
        try {
          await api.saveCaptions(ownerId, c.id, cues || []);
        } catch {
          /* best-effort; export still uses library state */
        }
      }

      const started = await api.exportClips(ownerId, clipIds, {
        captionStyle,
        burnCaptions: captionStyle.burn !== false,
      });
      const jobId = started.job_id;
      if (!jobId) throw new Error("export did not return a job id");

      let job;
      for (;;) {
        await new Promise((r) => setTimeout(r, 400));
        job = await api.getExportJob(jobId);
        if (onOwner()) {
          // Trust job.percent (0→99 while running). Do not freeze a bad early 99%.
          if (typeof job.percent === "number") {
            setExportPercent(Math.max(0, Math.min(100, job.percent)));
          }
          if (job.message) setExportMsg(stripTrailingPercent(job.message));
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
      activeClip?.export_dir ||
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
      currentTimeRef.current = next;
      lastTimeTickRef.current = 0;
      setCurrentTime(next);
    }
  }

  function onVideoTimeUpdate(e) {
    const t = e.target.currentTime;
    const now = performance.now();
    // Video clock must not rebuild the caption notebook ~15×/s
    if (now - lastTimeTickRef.current < 250 && Math.abs(t - currentTimeRef.current) < 0.3) {
      return;
    }
    lastTimeTickRef.current = now;
    currentTimeRef.current = t;
    setCurrentTime(t);
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
      ? api.mediaUrl(source.video_path, source.updated_at)
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

  // Monitor caption = identical Pillow PNG as export (not browser text metrics).
  useEffect(() => {
    const text = (activeCaption?.text || "").trim();
    const vw = videoRef.current?.videoWidth || 0;
    const vh = videoRef.current?.videoHeight || 0;
    if (!text || !vw || !vh || captionStyle.burn === false) {
      setPlatePreview(null);
      platePreviewKeyRef.current = "";
      return undefined;
    }
    const key = JSON.stringify({
      text,
      style: captionStyle,
      vw,
      vh,
    });
    if (key === platePreviewKeyRef.current && platePreview) {
      return undefined;
    }
    if (platePreviewTimerRef.current) clearTimeout(platePreviewTimerRef.current);
    let cancelled = false;
    platePreviewTimerRef.current = setTimeout(() => {
      api
        .captionPlatePreview({
          text,
          caption_style: captionStyle,
          video_w: vw,
          video_h: vh,
        })
        .then((res) => {
          if (cancelled) return;
          platePreviewKeyRef.current = key;
          setPlatePreview(res);
        })
        .catch(() => {
          if (!cancelled) setPlatePreview(null);
        });
    }, 60);
    return () => {
      cancelled = true;
      if (platePreviewTimerRef.current) clearTimeout(platePreviewTimerRef.current);
    };
    // platePreview intentionally omitted — we only re-fetch when inputs change
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [
    activeCaption?.id,
    activeCaption?.text,
    captionStyle,
    source?.id,
    videoBox.width,
    videoBox.height,
    captionStyle.burn,
  ]);

  const selectedAgent = (selectedId && agentUi[selectedId]) || {};
  const agentBusy = !!selectedAgent.busy;
  const agentMsg = selectedAgent.msg || null;
  const agentMsgStep = selectedAgent.step || null;
  const agentPercent = selectedAgent.percent ?? null;
  const replyBusy = !!selectedAgent.replyBusy;
  const thisCaptionJob =
    captionJob &&
    source &&
    captionJob.sourceId === source.id &&
    captionJob.clipId === activeClipId
      ? captionJob
      : null;
  const captionsBusy = thisCaptionJob?.phase === "slicing";
  const captionsCleaning = thisCaptionJob?.phase === "cleaning";

  const summaryTextDone = !!(
    summaryTextDraft.trim() || source?.summary_post_text
  );
  const summaryApproved = !!(source?.agent_run?.summary?.approved);
  const planDone = !!(source?.clips || []).some((c) => c.from_plan);
  const ingestLive = ["queued", "resolving", "downloading", "transcribing"].includes(
    source?.job?.stage
  );
  const canRetryTranscribe =
    source &&
    source.status === "error" &&
    source.video_path &&
    !retryBusy;
  const canRetryDownload =
    source &&
    source.url &&
    !source.video_path &&
    !retryBusy &&
    !ingestLive &&
    (source.status === "error" ||
      source.status === "downloading" ||
      source.status === "pending");
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
    (summaryTextDone || planDone ? 1 : 0) +
    (summaryTextDone ? 1 : 0) +
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
    setAgentStep("opener");
    setError(null);
    setImportNotice(null);
  }

  const exportPaths = useMemo(() => {
    const paths = [];
    if (activeClip?.export_dir) paths.push(shortExportPath(activeClip.export_dir));
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

  captionHandlersRef.current = {
    onSeek: seekTo,
    onDraftChange: (cues) => {
      captionsDraftRef.current = cues;
    },
    onFocusChange: (focused) => {
      captionFocusedRef.current = focused;
    },
    onClipPatched: (updated) => {
      if (!updated?.id) return;
      setSource((prev) => {
        if (!prev) return prev;
        return {
          ...prev,
          clips: (prev.clips || []).map((c) => {
            if (c.id !== updated.id) return c;
            if (captionFocusedRef.current) {
              return {
                ...c,
                captions: captionsDraftRef.current ?? c.captions,
                captions_meta: updated.captions_meta ?? c.captions_meta,
              };
            }
            return { ...c, ...updated };
          }),
        };
      });
    },
    onGenerate: generateCaptions,
    onError: (msg) => setError(msg),
  };

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

      <div
        className={
          "layout" +
          (!source
            ? " layout--home"
            : craftCollapsed
              ? " layout--craft-collapsed"
              : "")
        }
      >
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
                    flushPostIfDirty();
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
                      {s.status === "transcribing" &&
                      (s.job?.stt_health?.level === "critical" ||
                        s.job?.stt_health?.level === "stalled")
                        ? `STT ${s.job.stt_health.level}`
                        : s.status === "transcribing" && s.job?.stt_health?.level === "slow"
                          ? "STT slow"
                          : s.status === "transcribing" && s.job?.percent != null
                            ? `transcribing ${Number(s.job.percent).toFixed(0)}%`
                            : s.status === "transcribing" && s.job?.elapsed_s != null
                              ? `transcribing ${formatElapsedLabel(s.job.elapsed_s)}`
                              : s.status}
                    </span>
                    {agentUi[s.id]?.busy ? (
                      <>
                        <span className="sep">·</span>
                        <span className="status-word status-word--progress">
                          {AGENT_BUSY_LABEL[agentUi[s.id].step] || "agent"}{" "}
                          {formatClock(
                            elapsedSeconds(
                              agentStartMs(
                                s,
                                agentUi[s.id],
                                agentUi[s.id].step
                              ),
                              agentNow
                            )
                          )}
                        </span>
                      </>
                    ) : null}
                    {s.status === "ready" &&
                      (s.pipeline?.stages?.transcribe?.duration_s != null ||
                        s.pipeline?.stt_realtime_factor != null) && (
                        <>
                          <span className="sep">·</span>
                          <span
                            className="text-mono list-item__timing"
                            title="STT wall time · realtime factor"
                          >
                            {s.pipeline?.stages?.transcribe?.duration_s != null
                              ? formatElapsedLabel(
                                  s.pipeline.stages.transcribe.duration_s
                                )
                              : "STT"}
                            {s.pipeline?.stt_realtime_factor != null
                              ? ` · ${Number(s.pipeline.stt_realtime_factor).toFixed(0)}×`
                              : ""}
                          </span>
                        </>
                      )}
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
                          onClick={() => selectClip(c)}
                          role="button"
                          tabIndex={0}
                          onKeyDown={(e) => {
                            if (e.key === "Enter" || e.key === " ") {
                              e.preventDefault();
                              selectClip(c);
                            }
                          }}
                        >
                          <div className="clip-card__top">
                            <span className="clip-card__title">{c.title}</span>
                          </div>
                          <div className="clip-card__meta">
                            <span className="clip-card__range">
                              {formatTs(c.t_in)} – {formatTs(c.t_out)}
                            </span>
                            <span className="sep">·</span>
                            <span className="clip-card__range">
                              {Math.max(
                                0,
                                (c.t_out || 0) - (c.t_in || 0)
                              ).toFixed(1)}
                              s
                            </span>
                            <span className="sep">·</span>
                            <span className={statusWordClass(st)}>{st}</span>
                            <button
                              type="button"
                              className="btn btn--icon btn--danger list-item__remove"
                              title="Delete clip"
                              onClick={(e) => {
                                e.stopPropagation();
                                removeClip(c.id);
                              }}
                            >
                              ×
                            </button>
                          </div>
                          {showWhyOnCards && c.why && (
                            <p className="clip-card__why">why · {c.why}</p>
                          )}
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
                    {source.url &&
                      (source.video_path || source.folder) &&
                      source.status !== "downloading" && (
                        <>
                          <span className="sep">·</span>
                          <button
                            type="button"
                            className="linkish"
                            onClick={rebuildAudio}
                            disabled={retryBusy}
                            title="Re-fetch sound with ffmpeg (fixes 5s HLS static). Picture stays."
                          >
                            Rebuild audio
                          </button>
                        </>
                      )}
                    {source.status === "ready" && getPipeline(source) && (
                      <>
                        <span className="sep">·</span>
                        <button
                          type="button"
                          className="linkish"
                          aria-expanded={timingInfoOpen}
                          onClick={() => setTimingInfoOpen((o) => !o)}
                        >
                          info
                        </button>
                      </>
                    )}
                  </p>
                  {timingInfoOpen &&
                    source.status === "ready" &&
                    getPipeline(source) && (
                      <div className="pipeline-timing-pop" role="dialog" aria-label="Pipeline timing">
                        <div className="pipeline-timing-pop__head">
                          <span className="pipeline-timing-pop__title">Pipeline timing</span>
                          <button
                            type="button"
                            className="linkish"
                            onClick={() => setTimingInfoOpen(false)}
                          >
                            close
                          </button>
                        </div>
                        <PipelineTiming source={source} />
                      </div>
                    )}
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

              {(source.status === "error" ||
                (canRetryDownload && source.status !== "ready")) && (
                <div className="source-alert source-alert--error">
                  <p className="source-alert__title">
                    {source.error || "Something failed on this source."}
                  </p>
                  {canRetryDownload && (
                    <div className="source-alert__actions">
                      <button
                        type="button"
                        className="btn btn--primary btn--sm"
                        onClick={retryDownload}
                        disabled={retryBusy}
                      >
                        {retryBusy ? "Retrying…" : "Retry download"}
                      </button>
                      <span className="text-meta">
                        same folder — leftover picture is reused
                      </span>
                    </div>
                  )}
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

              {source.status !== "ready" &&
                source.status !== "error" &&
                ingestLive && <PipelineProgress source={source} />}

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
                    {agentFlowEnabled && (
                      <button
                        type="button"
                        role="tab"
                        aria-selected={paneTab === "agent"}
                        className={`pane-tab pane-tab--agent ${
                          paneTab === "agent" ? "pane-tab--active" : ""
                        }`}
                        onClick={() => {
                          flushPostIfDirty();
                          setPaneTab("agent");
                        }}
                      >
                        Agent
                      </button>
                    )}
                    <button
                      type="button"
                      role="tab"
                      aria-selected={paneTab === "transcript"}
                      className={`pane-tab ${
                        paneTab === "transcript" ? "pane-tab--active" : ""
                      }`}
                      onClick={() => {
                        flushPostIfDirty();
                        setPaneTab("transcript");
                      }}
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
                      onClick={() => {
                        flushPostIfDirty();
                        setPaneTab("captions");
                      }}
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
                    <button
                      type="button"
                      role="tab"
                      aria-selected={paneTab === "publish"}
                      className={`pane-tab ${
                        paneTab === "publish" ? "pane-tab--active" : ""
                      }`}
                      onClick={() => {
                        flushPostIfDirty();
                        setPaneTab("publish");
                      }}
                    >
                      Publish
                    </button>
                  </div>

                  <div className="center-scroll">
                    {paneTab === "agent" && agentFlowEnabled ? (
                      <AgentDesk
                        source={source}
                        agentStep={agentStep}
                        setAgentStep={setAgentStep}
                        agentPack={agentPack}
                        xaiReady={xaiReady}
                        agentBusy={agentBusy}
                        agentMsg={agentMsg}
                        agentMsgStep={agentMsgStep}
                        agentPercent={agentPercent}
                        agentStartedAt={selectedAgent.startedAt}
                        replyBusy={replyBusy}
                        summaryTextDraft={summaryTextDraft}
                        setSummaryTextDraft={setSummaryTextDraft}
                        summaryPromptDraft={summaryPromptDraft}
                        setSummaryPromptDraft={setSummaryPromptDraft}
                        clipPromptDraft={clipPromptDraft}
                        setClipPromptDraft={setClipPromptDraft}
                        planImportText={planImportText}
                        setPlanImportText={setPlanImportText}
                        planImportBusy={planImportBusy}
                        planDone={planDone}
                        planFileRef={planFileRef}
                        onSaveSummaryText={saveSummaryText}
                        onSaveSummaryPrompt={saveSummaryPrompt}
                        onSaveClipPrompt={saveClipPrompt}
                        onDraft={runSummaryAgent}
                        onApprove={approveSummaryOpener}
                        onRunClips={runClipsAgent}
                        onApproveClips={approveClipsCut}
                        onRunWriter={runWriterAgent}
                        onSaveWriterPost={saveWriterPost}
                        onSaveWriterFeedback={saveWriterFeedback}
                        onSaveWriterBundle={saveWriterBundle}
                        onApproveWriter={approveWriterPosts}
                        onRunCaptions={runCaptionsAgent}
                        onRunReply={runReplyAgent}
                        onSaveReply={saveReplyPost}
                        craftCollapsed={craftCollapsed}
                        onExportSummary={exportSummaryPackage}
                        onExportClip={exportClipPackage}
                        onImportPlan={importClipPlan}
                        onPlanFile={() => planFileRef.current?.click()}
                        onPlanFileChosen={onPlanFileChosen}
                        onReveal={(which) =>
                          api
                            .revealPath(
                              (source.folder || "") + "/agent-export/" + which
                            )
                            .catch(() => {})
                        }
                        onDismissMsg={() => {
                          if (selectedId) {
                            patchAgentUi(selectedId, { msg: null });
                          }
                        }}
                      />
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
                                key={activeClip.id}
                                className="input paper-input"
                                rows={10}
                                value={postDraft}
                                placeholder="Write or edit the X quote body…"
                                onFocus={() => {
                                  postFocusedRef.current = true;
                                }}
                                onChange={(e) => {
                                  const t = e.target.value;
                                  setPostDraft(t);
                                  // Live-update local clip so counts / hasPost stay current
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
                                onBlur={(e) => {
                                  postFocusedRef.current = false;
                                  // Autosave whenever the post field loses focus
                                  commitPostText(e.target.value);
                                }}
                                spellCheck
                              />
                              <div className="post-package__actions">
                                <button
                                  type="button"
                                  className="btn btn--primary btn--sm"
                                  disabled={!postDraft.trim()}
                                  onClick={() =>
                                    copyText(postDraft, "post")
                                  }
                                >
                                  {copyFlash === "post" ? "Copied" : "Copy post"}
                                </button>
                              </div>

                              <div className="post-url-fields">
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
                    ) : paneTab === "publish" ? (
                      <div className="paper paper--publish">
                        <div className="paper__body">
                          <section className="publish-block">
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
                                {exportBusy ? "Exporting…" : "Export clip"}
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
                                  exportBusy
                                    ? undefined
                                    : exportFailed
                                      ? "error"
                                      : "success"
                                }
                                paths={
                                  !exportBusy &&
                                  !exportFailed &&
                                  exportPaths.length
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
                          </section>
                        </div>
                      </div>
                    ) : paneTab === "captions" ? (
                      <CaptionEditor
                        sourceId={source.id}
                        clipId={activeClip?.id || ""}
                        tIn={activeClip?.t_in || 0}
                        captions={clipCaptions}
                        captionsRev={`${activeClip?.id || ""}:${
                          captionsMeta?.generated_at || ""
                        }:${captionsMeta?.cleaned_at || ""}:${
                          captionsMeta?.cleaning ? "1" : "0"
                        }:${captionsMeta?.cleaned ? "1" : "0"}`}
                        captionsStale={!!captionsStale}
                        activeCaptionId={activeCaption?.id || null}
                        captionsBusy={captionsBusy}
                        captionsCleaning={captionsCleaning}
                        handlersRef={captionHandlersRef}
                      />
                    ) : (
                      <>
                        <div className="paper">
                          <div className="paper__body paper__body--measure">
                            <div className="paper__grid" ref={paperGridRef}>
                              <div className="paper__margin" aria-hidden>
                                {activeClip && marginMarks && (
                                  <>
                                    <div
                                      className="paper__margin-rule"
                                      style={{
                                        top: marginMarks.inTop,
                                        height: marginMarks.height,
                                      }}
                                    />
                                    <div
                                      className="paper__margin-cap"
                                      style={{ top: marginMarks.inTop }}
                                    />
                                    <div
                                      className="paper__margin-cap"
                                      style={{ top: marginMarks.outTop }}
                                    />
                                    <span
                                      className="paper__margin-label"
                                      style={{
                                        top: Math.max(0, marginMarks.inTop - 12),
                                      }}
                                    >
                                      in
                                    </span>
                                    <span
                                      className="paper__margin-label"
                                      style={{ top: marginMarks.outTop + 4 }}
                                    >
                                      out
                                    </span>
                                    <div
                                      className="paper__margin-playhead"
                                      style={{ top: marginMarks.phTop }}
                                    />
                                  </>
                                )}
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
          <aside className={`craft-col ${craftCollapsed ? "craft-col--collapsed" : ""}`}>
            <button
              type="button"
              className="craft-col__toggle"
              title={craftCollapsed ? "Show player and export" : "Hide player and export"}
              aria-pressed={craftCollapsed}
              onClick={() => {
                setCraftCollapsed((c) => {
                  const next = !c;
                  try {
                    localStorage.setItem(LS_CRAFT_COLLAPSED, next ? "1" : "0");
                  } catch {
                    /* ignore */
                  }
                  return next;
                });
              }}
            >
              {craftCollapsed ? "Show desk" : "Hide desk"}
            </button>
            <div className="craft-col__scroll">
              <div
                ref={monitorRef}
                className={`monitor ${
                  monitorFullscreen ? "monitor--fullscreen" : ""
                }`}
              >
                <video
                  ref={videoRef}
                  src={mediaSrc}
                  controls
                  controlsList="nofullscreen"
                  disablePictureInPicture
                  playsInline
                  onTimeUpdate={onVideoTimeUpdate}
                />
                {captionStyle.burn !== false &&
                platePreview?.png_base64 &&
                videoBox.width > 0 ? (
                  <div
                    className="caption-overlay"
                    aria-hidden
                    style={{
                      left: videoBox.left,
                      top: videoBox.top,
                      width: videoBox.width,
                      height: videoBox.height,
                    }}
                  >
                    {/* Exact export plate (Pillow) — scale full-frame coords into letterbox */}
                    <img
                      className="caption-overlay__img"
                      alt=""
                      draggable={false}
                      src={`data:image/png;base64,${platePreview.png_base64}`}
                      style={{
                        left:
                          (platePreview.x / platePreview.video_w) *
                          videoBox.width,
                        top:
                          (platePreview.y / platePreview.video_h) *
                          videoBox.height,
                        width:
                          (platePreview.plate_w / platePreview.video_w) *
                          videoBox.width,
                        height:
                          (platePreview.plate_h / platePreview.video_h) *
                          videoBox.height,
                      }}
                    />
                  </div>
                ) : null}
                <div
                  className={`monitor__badge ${inRange ? "monitor__badge--in" : ""}`}
                >
                  {formatTs(currentTime)}
                  {inRange ? " · in clip" : ""}
                </div>
                <button
                  type="button"
                  className="monitor__fs"
                  onClick={toggleMonitorFullscreen}
                  title={
                    monitorFullscreen
                      ? "Exit fullscreen"
                      : "Fullscreen with captions"
                  }
                  aria-pressed={monitorFullscreen}
                >
                  {monitorFullscreen ? "Exit full" : "Fullscreen"}
                </button>
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

              <div
                className={`craft-zone ${
                  craftOpen.clip ? "" : "craft-zone--collapsed"
                }`}
              >
                <button
                  type="button"
                  className="craft-zone__head craft-zone__head--toggle"
                  onClick={() => toggleCraftSection("clip")}
                  aria-expanded={craftOpen.clip}
                >
                  <h3 className="craft-zone__title">Clip</h3>
                  <span className="craft-zone__chevron" aria-hidden>
                    {craftOpen.clip ? "▾" : "▸"}
                  </span>
                </button>
                {craftOpen.clip && (
                <div className="craft-zone__body">
                <label className="field">
                  <span className="field__label">Clip title</span>
                  <input
                    className="input input--serif"
                    value={clipTitleDraft}
                    onFocus={() => {
                      clipTitleFocusedRef.current = true;
                    }}
                    onChange={(e) => {
                      const v = e.target.value;
                      setClipTitleDraft(v);
                      // Live-update sidebar card while typing
                      setSource((prev) => {
                        if (!prev || !activeClipId) return prev;
                        return {
                          ...prev,
                          clips: (prev.clips || []).map((c) =>
                            c.id === activeClipId ? { ...c, title: v } : c
                          ),
                        };
                      });
                    }}
                    onBlur={() => {
                      clipTitleFocusedRef.current = false;
                      commitClipTitle();
                    }}
                    onKeyDown={(e) => {
                      if (e.key === "Enter") {
                        e.preventDefault();
                        e.currentTarget.blur();
                      }
                    }}
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
                )}
              </div>

              <div
                className={`craft-zone craft-zone--captions ${
                  craftOpen.caption ? "" : "craft-zone--collapsed"
                }`}
              >
                <button
                  type="button"
                  className="craft-zone__head craft-zone__head--toggle"
                  onClick={() => toggleCraftSection("caption")}
                  aria-expanded={craftOpen.caption}
                >
                  <h3 className="craft-zone__title">Caption plate</h3>
                  <span className="craft-zone__chevron" aria-hidden>
                    {craftOpen.caption ? "▾" : "▸"}
                  </span>
                </button>
                {craftOpen.caption && (
                <div className="craft-zone__body">
                <div className="caption-plate-controls">
                  <div className="caption-plate-controls__row">
                    <label className="field">
                      <span className="field__label">Burn-in</span>
                      <select
                        className="select"
                        value={captionStyle.burn === false ? "off" : "on"}
                        onChange={(e) =>
                          patchCaptionStyle({ burn: e.target.value === "on" })
                        }
                      >
                        <option value="on">On · burn into export</option>
                        <option value="off">Off · source already has captions</option>
                      </select>
                    </label>
                  </div>
                  <div
                    className={
                      captionStyle.burn === false
                        ? "caption-plate-controls__rest--off"
                        : undefined
                    }
                  >
                  <div className="caption-plate-controls__row">
                    <label className="field">
                      <span className="field__label">Type</span>
                      <select
                        className="select"
                        value={captionStyle.font}
                        onChange={(e) =>
                          patchCaptionStyle({ font: e.target.value })
                        }
                      >
                        <option value="serif">Serif · bold</option>
                        <option value="sans">Sans · bold</option>
                      </select>
                    </label>
                    <label className="field">
                      <span className="field__label">Plate</span>
                      <select
                        className="select"
                        value={captionStyle.plate}
                        onChange={(e) =>
                          patchCaptionStyle({ plate: e.target.value })
                        }
                      >
                        <option value="cream">Cream</option>
                        <option value="night">Night</option>
                      </select>
                    </label>
                  </div>
                  <div className="caption-plate-controls__row">
                    <label className="field">
                      <span className="field__label">Position</span>
                      <select
                        className="select"
                        value={captionStyle.anchor}
                        onChange={(e) =>
                          patchCaptionStyle({ anchor: e.target.value })
                        }
                      >
                        <option value="bottom">Bottom</option>
                        <option value="lower_third">Lower third</option>
                        <option value="middle">Middle</option>
                        <option value="top">Top</option>
                      </select>
                    </label>
                    <label className="field">
                      <span className="field__label">Align</span>
                      <select
                        className="select"
                        value={captionStyle.align}
                        onChange={(e) =>
                          patchCaptionStyle({ align: e.target.value })
                        }
                      >
                        <option value="left">Left</option>
                        <option value="center">Center</option>
                        <option value="right">Right</option>
                      </select>
                    </label>
                  </div>
                  <label className="field caption-plate-controls__row--full">
                    <span className="field__label">Size</span>
                    <div className="caption-plate-controls__nudge">
                      <input
                        type="range"
                        min={30}
                        max={90}
                        step={1}
                        value={Math.round(
                          (captionStyle.font_size || 0.052) * 1000
                        )}
                        onChange={(e) =>
                          patchCaptionStyle({
                            font_size: Number(e.target.value) / 1000,
                          })
                        }
                        aria-valuetext={`${(
                          (captionStyle.font_size || 0.052) * 100
                        ).toFixed(1)}% of frame`}
                      />
                      <span className="caption-plate-controls__nudge-val">
                        {((captionStyle.font_size || 0.052) * 100).toFixed(1)}%
                      </span>
                    </div>
                  </label>
                  <label className="field caption-plate-controls__row--full">
                    <span className="field__label">Nudge vertical</span>
                    <div className="caption-plate-controls__nudge">
                      <input
                        type="range"
                        min={-20}
                        max={20}
                        step={1}
                        value={Math.round((captionStyle.offset_y || 0) * 100)}
                        onChange={(e) =>
                          patchCaptionStyle({
                            offset_y: Number(e.target.value) / 100,
                          })
                        }
                      />
                      <span className="caption-plate-controls__nudge-val">
                        {(captionStyle.offset_y || 0) > 0 ? "+" : ""}
                        {Math.round((captionStyle.offset_y || 0) * 100)}%
                      </span>
                    </div>
                  </label>
                  <p className="caption-plate-controls__hint">
                    Preview on the monitor matches export burn-in. Style is saved
                    on this device. Export burns when cues exist and always writes
                    an .srt sidecar.
                  </p>
                  </div>
                </div>
                <div className="clip-caption-actions">
                  <button
                    type="button"
                    className="btn"
                    onClick={() => setPaneTab("captions")}
                    disabled={!activeClip}
                  >
                    {clipCaptions.length
                      ? `Edit text (${clipCaptions.length})`
                      : "Edit text"}
                  </button>
                  {clipCaptions.length ? (
                    <button
                      type="button"
                      className="btn btn--primary"
                      onClick={async () => {
                        if (!source || !activeClip) return;
                        try {
                          await persistCaptions();
                          setCaptionsMsg("Caption changes applied");
                        } catch (err) {
                          setError(String(err.message || err));
                        }
                      }}
                      disabled={!activeClip || captionsBusy}
                    >
                      Apply changes
                    </button>
                  ) : (
                    <button
                      type="button"
                      className="btn btn--primary"
                      onClick={generateCaptions}
                      disabled={!activeClip || captionsBusy || captionsCleaning}
                    >
                      {captionsBusy ? "Generating…" : "Generate captions"}
                    </button>
                  )}
                </div>
                {clipCaptions.length > 0 && (
                  <button
                    type="button"
                    className="btn btn--ghost clip-caption-actions__regen"
                    onClick={generateCaptions}
                    disabled={!activeClip || captionsBusy || captionsCleaning}
                  >
                    {captionsBusy
                      ? "Generating…"
                      : captionsCleaning
                        ? "Cleaning names…"
                        : "Regenerate from transcript"}
                  </button>
                )}
                {captionsBusy && (
                  <JobStatus busy message="Generating captions…" />
                )}
                {captionsCleaning && !captionsBusy && (
                  <JobStatus
                    busy
                    message="Cleaning names… captions are ready to edit"
                  />
                )}
                {captionsMsg && !captionsBusy && !captionsCleaning && (
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
                <strong>small · faster:</strong> default. Best speed/quality for
                most shows. Long episodes are fine when you need clip finding more
                than perfect names.
              </p>
              <p className="empty-card__body">
                <strong>medium · clearer:</strong> when small mangles names,
                tickers, or jargon — or audio is noisy. ~2× slower; use when
                caption accuracy matters more than wait time.
              </p>
            </div>
            <div className="empty-card empty-card--warn">
              <p className="empty-card__body">
                First run of a model downloads weights (can take a while). Later
                runs reuse the cache. Free RAM helps STT stay fast on long
                episodes.
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
