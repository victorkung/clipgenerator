import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { api, formatTs } from "./api";

const DEFAULT_STAGES = [
  { id: "queued", label: "Queued" },
  { id: "resolving", label: "Resolve" },
  { id: "downloading", label: "Download" },
  { id: "transcribing", label: "Transcribe" },
  { id: "done", label: "Ready" },
];

/** Least → most powerful. Labels stay short; `guide` is the length/when-to-use hint. */
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
  {
    id: "turbo",
    label: "turbo · strong",
    guide:
      "Near-large quality, still relatively fast. Best upgrade for long pods that need accuracy.",
  },
  {
    id: "large-v3",
    label: "large-v3 · max",
    guide:
      "Highest accuracy; slowest & most RAM. Short clips or very hard audio only.",
  },
];

/** Soft threshold for “this might be a promo clip, not the full episode.” */
const SHORT_SOURCE_SECS = 90;

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

function pillStatus(status) {
  if (status === "ready" || status === "rendered") return "pill pill--ready";
  if (status === "error") return "pill pill--error";
  if (["pending", "downloading", "transcribing", "queued"].includes(status)) {
    return "pill pill--progress";
  }
  return "pill";
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
      {/* In/out brackets + playhead — local clip studio mark */}
      <path
        d="M5 6.5V5h3M5 17.5V19h3M19 6.5V5h-3M19 17.5V19h-3"
        stroke="currentColor"
        strokeWidth="1.75"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
      <path
        d="M8 12h8"
        stroke="currentColor"
        strokeWidth="1.5"
        strokeLinecap="round"
        opacity="0.55"
      />
      <circle cx="12" cy="12" r="1.75" fill="currentColor" />
    </svg>
  );
}

function BrandMark() {
  return (
    <div className="brand-mark" title="clipgenerator" aria-hidden>
      <CutMarkSvg />
    </div>
  );
}

function JobStatus({
  busy,
  message,
  percent,
  onDismiss,
  onReveal,
  revealLabel = "Reveal in Finder",
}) {
  if (!message) return null;
  return (
    <div
      className={`job-status ${busy ? "job-status--busy" : "job-status--done"}`}
      role="status"
      aria-live="polite"
    >
      <div className="job-status__row">
        {busy && <span className="banner__spinner" />}
        <span className="job-status__text">
          {message}
          {busy && percent != null && (
            <span className="banner__pct"> · {percent}%</span>
          )}
        </span>
        {!busy && (
          <div className="job-status__actions">
            {onReveal && (
              <button type="button" className="btn btn--sm" onClick={onReveal}>
                {revealLabel}
              </button>
            )}
            {onDismiss && (
              <button type="button" className="btn btn--sm btn--ghost" onClick={onDismiss}>
                Dismiss
              </button>
            )}
          </div>
        )}
      </div>
      {busy && percent != null && (
        <div className="banner__track" aria-hidden>
          <div
            className="banner__fill"
            style={{ width: `${Math.min(100, Math.max(2, percent))}%` }}
          />
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
      <div className="pipeline__steps">
        {stages.map((st, i) => {
          let cls = "pipeline__step";
          if (stage === "error") cls += i <= idx ? " pipeline__step--error" : "";
          else if (i < idx) cls += " pipeline__step--done";
          else if (i === idx) cls += " pipeline__step--active";
          return (
            <div key={st.id} className={cls}>
              <div className="pipeline__dot" />
              <span>{st.label}</span>
            </div>
          );
        })}
      </div>
      <div className="pipeline__track">
        <div
          className="pipeline__fill"
          style={{ width: `${Math.min(100, Math.max(2, percent))}%` }}
        />
      </div>
      <div className="pipeline__meta">
        <span className="pipeline__pct">{percent}%</span>
        <span>{msg}</span>
      </div>
      {detail && <p className="pipeline__detail">{detail}</p>}
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
  const [captionsBusy, setCaptionsBusy] = useState(false);
  const [captionsMsg, setCaptionsMsg] = useState(null);
  const [agentBusy, setAgentBusy] = useState(false);
  const [agentMsg, setAgentMsg] = useState(null);
  const [agentMsgStep, setAgentMsgStep] = useState(null); // summary | clip | import
  const [planImportText, setPlanImportText] = useState("");
  const [planImportBusy, setPlanImportBusy] = useState(false);
  const [rightPane, setRightPane] = useState("transcript"); // transcript | captions
  const [mainTab, setMainTab] = useState("editor"); // editor | agent
  const [agentFlowEnabled, setAgentFlowEnabled] = useState(true);
  const [inDraft, setInDraft] = useState("");
  const [outDraft, setOutDraft] = useState("");
  const [titleDraft, setTitleDraft] = useState("");
  const [editingTitle, setEditingTitle] = useState(false);
  const [podbriefDraft, setPodbriefDraft] = useState("");
  const [summaryUrlDraft, setSummaryUrlDraft] = useState("");
  const [postOpen, setPostOpen] = useState(false);
  const [importNotice, setImportNotice] = useState(null);
  const [retryBusy, setRetryBusy] = useState(false);
  const [copyFlash, setCopyFlash] = useState(null);
  const videoRef = useRef(null);
  const titleInputRef = useRef(null);
  const planFileRef = useRef(null);
  const selectedIdRef = useRef(selectedId);
  const exportOwnerIdRef = useRef(null);
  const copyTimerRef = useRef(null);

  const refreshList = useCallback(async () => {
    const list = await api.listSources();
    setSources(list);
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
      setPodbriefDraft(s.podbrief_text || "");
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

  useEffect(() => {
    refreshList().catch((e) => setError(String(e.message || e)));
  }, [refreshList]);

  useEffect(() => {
    api
      .health()
      .then((h) => {
        if (typeof h.agent_flow === "boolean") setAgentFlowEnabled(h.agent_flow);
      })
      .catch(() => {});
  }, []);

  useEffect(() => {
    selectedIdRef.current = selectedId;
    setExportMsg(null);
    setExportPercent(null);
    setExportPath(null);
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

  // Auto-expand post package when clip has post content
  useEffect(() => {
    if (!activeClip) {
      setPostOpen(false);
      return;
    }
    if (activeClip.post_text || activeClip.why || activeClip.from_plan) {
      setPostOpen(true);
    }
  }, [activeClip?.id, activeClip?.post_text, activeClip?.why, activeClip?.from_plan]);

  useEffect(() => {
    if (editingTitle && titleInputRef.current) titleInputRef.current.focus();
  }, [editingTitle]);

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

  async function savePodbrief() {
    if (!source) return;
    try {
      const updated = await api.updateSource(source.id, {
        podbrief_text: podbriefDraft,
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
      if (podbriefDraft !== (source.podbrief_text || "")) {
        await savePodbrief();
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
      setMainTab("editor");
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
      setRightPane("captions");
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
          setError((job.errors || [job.message || "export failed"]).join("; "));
          setExportMsg(null);
          setExportPercent(null);
          setExportPath(null);
        }
      } else if (onOwner()) {
        setExportPercent(100);
        const out = job.out_dir || null;
        setExportPath(out);
        setExportMsg(
          `✓ ${job.message || `Exported ${n} clip(s)`}` +
            (out ? `\n${out}` : "") +
            (job.errors?.length
              ? `\n(${job.errors.length} failed: ${job.errors.join("; ")})`
              : "")
        );
      }
      if (onOwner()) await loadSource(ownerId);
      await refreshList();
    } catch (err) {
      if (onOwner()) {
        setError(String(err.message || err));
        setExportMsg(null);
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
    (!agentFlowEnabled || mainTab === "editor");

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

  const briefDone = !!(podbriefDraft.trim() || source?.podbrief_text);
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

  return (
    <div className="app">
      <header className="top">
        <div className="brand">
          <BrandMark />
          <div className="brand__text">
            <span className="brand__name">clipgenerator</span>
            <span className="brand__tag">local clip studio</span>
          </div>
        </div>
        <form className="ingest" onSubmit={onIngest}>
          <div className="ingest__row">
            <input
              className="input"
              type="url"
              placeholder="Paste YouTube or X URL…"
              value={url}
              onChange={(e) => setUrl(e.target.value)}
              disabled={busy}
            />
            <select
              className="select"
              value={model}
              onChange={(e) => setModel(e.target.value)}
              disabled={busy}
              aria-label="Whisper model, least to most powerful"
              title={
                WHISPER_MODELS.find((m) => m.id === model)?.guide ||
                "Whisper model"
              }
            >
              {WHISPER_MODELS.map((m) => (
                <option key={m.id} value={m.id} title={m.guide}>
                  {m.label}
                </option>
              ))}
            </select>
            <button
              type="submit"
              className="btn btn--primary"
              disabled={busy}
              title="Download and transcribe on-device"
            >
              {busy ? "Queuing…" : "Add source"}
            </button>
          </div>
          <p className="ingest__hint" aria-live="polite">
            {WHISPER_MODELS.find((m) => m.id === model)?.guide}
          </p>
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
                  <button
                    type="button"
                    className="btn btn--icon btn--danger"
                    title="Remove from sidebar"
                    onClick={(e) => {
                      e.stopPropagation();
                      deleteSource(s.id, s.title);
                    }}
                  >
                    ×
                  </button>
                </div>
                <div className="list-item__meta">
                  <span className={pillStatus(s.status)}>{s.status}</span>
                  {s.duration != null && (
                    <span className="text-mono text-meta">{formatTs(s.duration)}</span>
                  )}
                  <span className="text-meta">
                    {(s.clips || []).length} clip{(s.clips || []).length === 1 ? "" : "s"}
                  </span>
                </div>
              </li>
            ))}
            {!sources.length && (
              <li className="sidebar__empty">No sources yet — paste a URL above.</li>
            )}
          </ul>
        </aside>

        <main className="main">
          {!source && (
            <div className="empty-main">
              <div className="empty-main__icon">
                <CutMarkSvg />
              </div>
              <h1 className="text-display">Cut clips that land</h1>
              <p className="text-meta">
                Paste a YouTube or X URL above. On-device transcription, transcript-tight
                marks, captions, and clean H.264 exports — all local.
              </p>
              <ul className="empty-main__steps">
                <li>
                  <span className="empty-main__step-num">1</span>
                  Ingest a source — download + Whisper on your machine
                </li>
                <li>
                  <span className="empty-main__step-num">2</span>
                  Mark in/out from playhead, keys, or transcript
                </li>
                <li>
                  <span className="empty-main__step-num">3</span>
                  Caption, write the post, export to clips/
                </li>
              </ul>
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
                      <span className="edit-hint">edit</span>
                    </h1>
                  )}
                  <p className="text-meta source-head__sub">
                    {source.duration != null && <span>{formatTs(source.duration)}</span>}
                    {source.model && <span>· {source.model}</span>}
                    <span className={pillStatus(source.status)}>{source.status}</span>
                    {source.job?.message && source.status !== "ready" && (
                      <span>· {source.job.message}</span>
                    )}
                  </p>
                  {source.error && <p className="error-text">{source.error}</p>}
                </div>
                <div className="source-head__actions">
                  <button
                    type="button"
                    className="btn btn--ghost btn--sm"
                    onClick={() => {
                      setTitleDraft(source.title || "");
                      setEditingTitle(true);
                    }}
                  >
                    Rename
                  </button>
                  <button
                    type="button"
                    className="btn btn--ghost btn--sm btn--danger"
                    onClick={() => deleteSource(source.id, source.title)}
                  >
                    Remove
                  </button>
                </div>
              </div>

              {isShortSource && source.status === "ready" && (
                <div className="source-alert source-alert--warning" role="status">
                  Short source ({formatTs(source.duration)}). Some X posts are promo clips —
                  full episodes may live on YouTube or a podcast feed.
                </div>
              )}

              {source.status === "error" && (
                <div className="source-alert source-alert--error">
                  <span className="banner__text">
                    {source.error || "Something failed on this source."}
                  </span>
                  {canRetryTranscribe && (
                    <button
                      type="button"
                      className="btn btn--sm"
                      onClick={retryTranscribe}
                      disabled={retryBusy}
                    >
                      {retryBusy ? "Retrying…" : "Retry transcribe"}
                    </button>
                  )}
                </div>
              )}

              {source.status !== "ready" && source.status !== "error" && (
                <PipelineProgress source={source} />
              )}

              {source.status === "ready" && agentFlowEnabled && (
                <div className="main-tabs" role="tablist" aria-label="Main views">
                  <button
                    type="button"
                    role="tab"
                    aria-selected={mainTab === "editor"}
                    className={`main-tab ${mainTab === "editor" ? "main-tab--active" : ""}`}
                    onClick={() => setMainTab("editor")}
                  >
                    Editor
                  </button>
                  <button
                    type="button"
                    role="tab"
                    aria-selected={mainTab === "agent"}
                    className={`main-tab ${mainTab === "agent" ? "main-tab--active" : ""}`}
                    onClick={() => setMainTab("agent")}
                  >
                    Agent flow
                  </button>
                </div>
              )}

              {importNotice && mainTab === "editor" && (
                <div
                  className="import-notice"
                  role="status"
                  onClick={() => setImportNotice(null)}
                >
                  {importNotice}
                  <span className="banner__dismiss"> · Dismiss</span>
                </div>
              )}

              {source.status === "ready" &&
                agentFlowEnabled &&
                mainTab === "agent" && (
                <div className="agent-flow">
                  <div className="agent-flow__toolbar">
                    <div className="agent-flow__context">
                      <span className="agent-flow__title">
                        {source.title}
                      </span>
                      {source.duration != null && (
                        <span className="text-mono">{formatTs(source.duration)}</span>
                      )}
                      <span className="pill pill--ready">ready</span>
                    </div>
                    <button
                      type="button"
                      className="btn btn--ghost btn--sm"
                      onClick={() => setMainTab("editor")}
                    >
                      ← Editor
                    </button>
                  </div>

                  <p className="text-meta agent-flow__intro">
                    Hand off to an external LLM, then import clips. This app owns media and
                    the timeline — editorial judgment stays in your private prompt pack.
                  </p>

                  <div className="agent-flow__status" aria-label="Pipeline progress">
                    <span className={`agent-chip ${briefDone ? "agent-chip--done" : ""}`}>
                      Brief
                    </span>
                    <span className="agent-chip__sep" aria-hidden />
                    <span
                      className={`agent-chip ${summaryUrlDone ? "agent-chip--done" : ""}`}
                    >
                      Summary URL
                    </span>
                    <span className="agent-chip__sep" aria-hidden />
                    <span className={`agent-chip ${planDone ? "agent-chip--done" : ""}`}>
                      Plan imported
                    </span>
                  </div>

                  {/* Step 1 — Summary */}
                  <section className="agent-step panel">
                    <div className="agent-step__head">
                      <span
                        className={`agent-step__num ${
                          briefDone || agentMsgStep === "summary" ? "agent-step__num--done" : ""
                        }`}
                      >
                        1
                      </span>
                      <div>
                        <h2 className="agent-step__title">Summary package</h2>
                        <p className="text-meta">
                          Optional brief + transcript → export → Summary LLM → post on X
                        </p>
                      </div>
                    </div>
                    <label className="field">
                      <span className="field__label">
                        High-level brief{" "}
                        <span className="text-meta">(optional themes / outline)</span>
                      </span>
                      <textarea
                        className="input agent-brief-panel__textarea"
                        rows={5}
                        value={podbriefDraft}
                        onChange={(e) => setPodbriefDraft(e.target.value)}
                        onBlur={savePodbrief}
                        placeholder="Paste a high-level brief or notes for the summary agent…"
                      />
                    </label>
                    <div className="clip-bar__row">
                      <button
                        type="button"
                        className="btn btn--primary"
                        onClick={exportSummaryPackage}
                        disabled={agentBusy}
                        title="Write agent-export/summary/"
                      >
                        {agentBusy && agentMsgStep === "summary"
                          ? "Exporting…"
                          : "Export for Summary agent"}
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

                  {/* Step 2 — Clips */}
                  <section
                    className={`agent-step panel ${
                      !summaryUrlDraft.trim() && !source.summary_post_url
                        ? "agent-step--locked"
                        : ""
                    }`}
                  >
                    <div className="agent-step__head">
                      <span
                        className={`agent-step__num ${
                          summaryUrlDone ? "agent-step__num--done" : ""
                        }`}
                      >
                        2
                      </span>
                      <div>
                        <h2 className="agent-step__title">Clip package</h2>
                        <p className="text-meta">
                          After the summary is live, paste its X URL — clips quote that post
                        </p>
                      </div>
                    </div>
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
                    <div className="clip-bar__row">
                      <button
                        type="button"
                        className="btn btn--primary"
                        onClick={exportClipPackage}
                        disabled={agentBusy || !summaryUrlDraft.trim()}
                        title={
                          !summaryUrlDraft.trim()
                            ? "Paste summary post URL first"
                            : "Write agent-export/clip/"
                        }
                      >
                        {agentBusy && agentMsgStep === "clip"
                          ? "Exporting…"
                          : "Export for Clip agent"}
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

                  {/* Step 3 — Import */}
                  <section className="agent-step panel">
                    <div className="agent-step__head">
                      <span
                        className={`agent-step__num ${planDone ? "agent-step__num--done" : ""}`}
                      >
                        3
                      </span>
                      <div>
                        <h2 className="agent-step__title">Import clip plan</h2>
                        <p className="text-meta">
                          Paste export JSON (or a fenced json block). Accepts seconds or M:SS
                          labels — then refine in Editor.
                        </p>
                      </div>
                    </div>
                    <label className="field">
                      <span className="field__label">Clip plan JSON</span>
                      <textarea
                        className="input agent-brief-panel__textarea agent-brief-panel__textarea--code"
                        rows={10}
                        value={planImportText}
                        onChange={(e) => setPlanImportText(e.target.value)}
                        placeholder={
                          '{\n  "version": 1,\n  "clips": [\n    {\n      "title": "…",\n      "t_in": 2628,\n      "t_out": 2785,\n      "post_text": "lowercase x post…",\n      "tags": ["@host"]\n    }\n  ]\n}'
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
                        {planImportBusy ? "Importing…" : "Import clips"}
                      </button>
                      <button
                        type="button"
                        className="btn"
                        onClick={() => planFileRef.current?.click()}
                        disabled={planImportBusy}
                      >
                        Choose file…
                      </button>
                      <button
                        type="button"
                        className="btn btn--ghost"
                        onClick={() => setMainTab("editor")}
                      >
                        Open Editor
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
              )}

              {source.status === "ready" &&
                mediaSrc &&
                (!agentFlowEnabled || mainTab === "editor") && (
                <div className="workspace">
                  <div className="player-col">
                    <div className="video-shell">
                      <video
                        ref={videoRef}
                        src={mediaSrc}
                        controls
                        onTimeUpdate={(e) => setCurrentTime(e.target.currentTime)}
                      />
                      <div
                        className={`video-shell__badge ${inRange ? "video-shell__badge--in" : ""}`}
                      >
                        {formatTs(currentTime)}
                        {inRange ? " · in clip" : ""}
                      </div>
                      {activeCaption?.text && (
                        <div className="caption-overlay" aria-live="polite">
                          <span className="caption-overlay__text">
                            {activeCaption.text}
                          </span>
                        </div>
                      )}
                    </div>

                    <div className="panel clip-bar">
                      {/* MARK zone — NLE-style */}
                      <div className="craft-zone">
                        <div className="craft-zone__head">
                          <h3 className="craft-zone__title">Mark</h3>
                          <p className="craft-zone__hint">
                            <span className="kbd">I</span> /{" "}
                            <span className="kbd">O</span> ·{" "}
                            <span className="kbd">⌥</span> /{" "}
                            <span className="kbd">⇧</span> transcript
                          </p>
                        </div>

                        <label className="field">
                          <span className="field__label">Clip title</span>
                          <input
                            className="input"
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

                        {activeClip && sourceDuration > 0 && (
                          <div
                            className="mark-timeline"
                            title="Clip range on full source"
                            aria-hidden
                          >
                            <div
                              className="mark-timeline__range"
                              style={{
                                left: `${Math.min(100, Math.max(0, (activeClip.t_in / sourceDuration) * 100))}%`,
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
                              className="mark-timeline__playhead"
                              style={{
                                left: `${Math.min(100, Math.max(0, (currentTime / sourceDuration) * 100))}%`,
                              }}
                            />
                          </div>
                        )}

                        <div className="mark-rail">
                          <div className="mark-rail__side mark-rail__side--start">
                            <div className="mark-rail__fields">
                              <label className="field">
                                <span className="field__label">In</span>
                                <input
                                  className="input input--mono"
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
                                className="btn btn--in btn--mark"
                                onClick={setInFromPlayhead}
                                disabled={!activeClip}
                                title="Set start at playhead (I)"
                              >
                                Set in · {formatTs(currentTime)}
                              </button>
                            </div>
                          </div>

                          <div className="mark-rail__center">
                            <span className="mark-rail__duration">
                              {activeClip
                                ? `${Math.max(0, activeClip.t_out - activeClip.t_in).toFixed(1)}s`
                                : "—"}
                            </span>
                            <span className="mark-rail__duration-label">duration</span>
                            <button
                              type="button"
                              className="btn btn--sm btn--ghost"
                              onClick={() => applyTypedTimes({ seek: "in" })}
                              disabled={!activeClip}
                              title="Apply typed times"
                            >
                              Apply
                            </button>
                          </div>

                          <div className="mark-rail__side mark-rail__side--end">
                            <div className="mark-rail__fields mark-rail__fields--end">
                              <label className="field">
                                <span className="field__label">Out</span>
                                <input
                                  className="input input--mono"
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
                                className="btn btn--primary btn--mark"
                                onClick={setOutFromPlayhead}
                                disabled={!activeClip}
                                title="Set end at playhead (O)"
                              >
                                Set out · {formatTs(currentTime)}
                              </button>
                            </div>
                          </div>
                        </div>

                        <div className="mark-actions">
                          <button
                            type="button"
                            className="btn btn--ghost btn--sm"
                            onClick={() => activeClip && seekTo(activeClip.t_in)}
                            disabled={!activeClip}
                          >
                            Jump in
                          </button>
                          <button
                            type="button"
                            className="btn btn--ghost btn--sm"
                            onClick={() =>
                              activeClip &&
                              seekTo(Math.max(0, (activeClip.t_out || 0) - 1))
                            }
                            disabled={!activeClip}
                          >
                            Jump out
                          </button>
                          {activeClip && (
                            <span
                              className={`range-chip ${inRange ? "range-chip--in" : ""}`}
                            >
                              {formatTs(activeClip.t_in)} → {formatTs(activeClip.t_out)}
                            </span>
                          )}
                        </div>
                      </div>

                      {/* EXPORT zone */}
                      <div className="craft-zone craft-zone--export">
                        <div className="craft-zone__head">
                          <h3 className="craft-zone__title">Export</h3>
                        </div>
                        <div className="export-bar">
                          <button
                            type="button"
                            className="btn btn--primary"
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
                            className="btn btn--ghost"
                            onClick={exportAll}
                            disabled={exportBusy}
                          >
                            Export all
                          </button>
                          <button
                            type="button"
                            className="btn btn--ghost"
                            onClick={generateCaptions}
                            disabled={!activeClip || captionsBusy}
                            title="Slice source transcript into captions for this clip’s in/out range"
                          >
                            {captionsBusy
                              ? "Generating…"
                              : clipCaptions.length
                                ? "Regenerate captions"
                                : "Generate captions"}
                          </button>
                          {clipCaptions.length > 0 && (
                            <button
                              type="button"
                              className="btn btn--ghost btn--sm"
                              onClick={() => setRightPane("captions")}
                            >
                              Edit captions ({clipCaptions.length})
                            </button>
                          )}
                        </div>
                        <JobStatus
                          busy={exportBusy}
                          message={exportMsg}
                          percent={exportPercent}
                          onDismiss={() => {
                            setExportMsg(null);
                            setExportPath(null);
                          }}
                          onReveal={
                            !exportBusy && (exportPath || activeClip?.export_path)
                              ? revealExport
                              : undefined
                          }
                        />
                        {captionsMsg && !captionsBusy && (
                          <JobStatus
                            busy={false}
                            message={captionsMsg}
                            onDismiss={() => setCaptionsMsg(null)}
                          />
                        )}
                        {captionsStale && (
                          <p className="caption-stale">
                            Clip range changed since captions were generated — regenerate
                            for an accurate cut.
                          </p>
                        )}
                        {activeClip?.status === "rendered" && activeClip?.export_path && (
                          <p className="export-path">
                            Saved · <code>{activeClip.export_path}</code>
                            {activeClip.captions_srt && (
                              <>
                                {" "}
                                · SRT · <code>{activeClip.captions_srt}</code>
                              </>
                            )}
                          </p>
                        )}
                      </div>

                      {/* POST zone (collapsible) */}
                      {activeClip && (
                        <div
                          className={`craft-zone ${
                            !postOpen ? "craft-zone--collapsed" : ""
                          }`}
                        >
                          <button
                            type="button"
                            className="craft-zone__toggle"
                            aria-expanded={postOpen}
                            onClick={() => setPostOpen((o) => !o)}
                          >
                            <span className="craft-zone__chevron">
                              {postOpen ? "▾" : "▸"}
                            </span>
                            Post package
                            {hasPostContent ? "" : " · optional"}
                            {postCharCount > 0 ? ` · ${postCharCount} chars` : ""}
                          </button>
                          {postOpen && (
                            <div className="post-package">
                              {activeClip.why && (
                                <p className="text-meta post-package__why">
                                  <strong>Why · </strong>
                                  {activeClip.why}
                                </p>
                              )}
                              <label className="field">
                                <span className="field__label field__label--row">
                                  <span>X post text (quote body)</span>
                                  <span className="post-package__count">
                                    {postCharCount}
                                    {postCharCount > 280 ? " · long for X" : ""}
                                  </span>
                                </span>
                                <textarea
                                  className="input post-package__text"
                                  rows={5}
                                  value={activeClip.post_text || ""}
                                  placeholder="Write or edit the X quote body…"
                                  onChange={(e) => {
                                    const text = e.target.value;
                                    setSource((prev) => {
                                      if (!prev || !activeClipId) return prev;
                                      return {
                                        ...prev,
                                        clips: (prev.clips || []).map((c) =>
                                          c.id === activeClipId
                                            ? { ...c, post_text: text }
                                            : c
                                        ),
                                      };
                                    });
                                  }}
                                  onBlur={async (e) => {
                                    if (!source || !activeClip) return;
                                    try {
                                      await api.updateClip(source.id, activeClip.id, {
                                        post_text: e.target.value,
                                      });
                                    } catch (err) {
                                      setError(String(err.message || err));
                                    }
                                  }}
                                  spellCheck
                                />
                              </label>
                              <div className="clip-bar__row">
                                <button
                                  type="button"
                                  className="btn btn--sm"
                                  disabled={!(activeClip.post_text || "").trim()}
                                  onClick={() =>
                                    copyText(activeClip.post_text || "", "post")
                                  }
                                >
                                  {copyFlash === "post" ? "Copied" : "Copy post"}
                                </button>
                                {source.summary_post_url && (
                                  <button
                                    type="button"
                                    className="btn btn--sm btn--ghost"
                                    onClick={() =>
                                      copyText(source.summary_post_url, "summary")
                                    }
                                    title="Quote this summary when posting the clip"
                                  >
                                    {copyFlash === "summary"
                                      ? "Copied"
                                      : "Copy summary URL"}
                                  </button>
                                )}
                                {source.url && (
                                  <button
                                    type="button"
                                    className="btn btn--sm btn--ghost"
                                    onClick={() => copyText(source.url, "source")}
                                  >
                                    {copyFlash === "source"
                                      ? "Copied"
                                      : "Copy source URL"}
                                  </button>
                                )}
                              </div>
                              {(activeClip.tags || []).length > 0 && (
                                <p className="text-meta">
                                  Tags · {(activeClip.tags || []).join(" ")}
                                </p>
                              )}
                            </div>
                          )}
                        </div>
                      )}
                    </div>

                    <div className="clip-list">
                      <div className="section-label">
                        <h3 className="section-label__title">Clips</h3>
                        <div className="section-label__actions">
                          <span className="section-label__count">
                            {(source.clips || []).length}
                          </span>
                          <button
                            type="button"
                            className="btn btn--sm"
                            onClick={addClip}
                            disabled={exportBusy}
                          >
                            + New clip
                          </button>
                        </div>
                      </div>
                      <ul className="clip-list__items">
                        {(source.clips || []).map((c) => (
                          <li
                            key={c.id}
                            className={`list-item list-item--panel ${
                              c.id === activeClipId ? "list-item--active" : ""
                            }`}
                            onClick={() => {
                              setActiveClipId(c.id);
                              seekTo(c.t_in);
                            }}
                          >
                            <div className="list-item__stack">
                              <span className="list-item__title">{c.title}</span>
                              <span className="text-mono text-secondary">
                                {formatTs(c.t_in)}–{formatTs(c.t_out)}
                                {c.score != null ? ` · score ${c.score}` : ""}
                                {(c.captions || []).length > 0
                                  ? ` · ${c.captions.length} cap`
                                  : ""}
                                {c.post_text ? " · post" : ""}
                              </span>
                            </div>
                            <span className={pillStatus(c.status)}>
                              {c.from_plan && c.status === "draft" ? "plan" : c.status}
                            </span>
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
                          </li>
                        ))}
                      </ul>
                    </div>
                  </div>

                  <div className="transcript-col">
                    <div className="section-label">
                      <div className="pane-tabs" role="tablist">
                        <button
                          type="button"
                          role="tab"
                          aria-selected={rightPane === "transcript"}
                          className={`pane-tab ${
                            rightPane === "transcript" ? "pane-tab--active" : ""
                          }`}
                          onClick={() => setRightPane("transcript")}
                        >
                          Transcript
                        </button>
                        <button
                          type="button"
                          role="tab"
                          aria-selected={rightPane === "captions"}
                          className={`pane-tab ${
                            rightPane === "captions" ? "pane-tab--active" : ""
                          }`}
                          onClick={() => setRightPane("captions")}
                        >
                          Captions
                          {clipCaptions.length > 0 ? (
                            <span className="pane-tab__count">{clipCaptions.length}</span>
                          ) : null}
                        </button>
                      </div>
                      {rightPane === "transcript" ? (
                        <span className="text-meta" title="⌥ click start · ⇧ click end · I/O keys">
                          ⌥ start · ⇧ end · I/O
                        </span>
                      ) : (
                        <span
                          className="text-meta"
                          title="Times are relative to clip start; scrub the source video"
                        >
                          clip-relative · 0:00 = export start
                        </span>
                      )}
                    </div>

                    {rightPane === "transcript" ? (
                      <div className="panel transcript">
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
                                i === activeSegIndex ? "transcript-line--active" : "",
                                segIn ? "transcript-line--in-range" : "",
                              ]
                                .filter(Boolean)
                                .join(" ")}
                              onClick={(e) => onSegClick(seg, e)}
                            >
                              <span className="transcript-line__ts">
                                {formatTs(seg.start)}
                              </span>
                              <span className="transcript-line__text">{seg.text}</span>
                            </button>
                          );
                        })}
                        {!segments.length && (
                          <p className="transcript__empty">No segments in transcript.</p>
                        )}
                      </div>
                    ) : (
                      <div className="panel transcript caption-editor">
                        {!activeClip ? (
                          <p className="transcript__empty">Select a clip first.</p>
                        ) : !clipCaptions.length ? (
                          <div className="caption-empty">
                            <p className="transcript__empty">
                              No captions yet for this clip.
                            </p>
                            <p className="text-meta caption-empty__hint">
                              Captions are built from the source transcript for the clip’s
                              in/out range. You still scrub the <strong>source</strong>{" "}
                              video; cue times are 0-based so they match the exported file.
                            </p>
                            <button
                              type="button"
                              className="btn btn--primary btn--sm"
                              onClick={generateCaptions}
                              disabled={captionsBusy}
                            >
                              {captionsBusy ? "Generating…" : "Generate captions"}
                            </button>
                          </div>
                        ) : (
                          <>
                            {captionsStale && (
                              <div className="caption-stale caption-stale--banner">
                                Range moved since generate — regenerate recommended.
                              </div>
                            )}
                            <p className="text-meta caption-empty__hint caption-empty__hint--inline">
                              Scrub the source; times are relative to this clip (0:00 =
                              export start).
                            </p>
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
                                      className="caption-row__seek text-mono"
                                      title="Seek to this cue on the source video"
                                      onClick={() =>
                                        activeClip &&
                                        seekTo(activeClip.t_in + Number(cap.start))
                                      }
                                    >
                                      {formatTs(cap.start)}–{formatTs(cap.end)}
                                    </button>
                                    <textarea
                                      className="caption-row__text input"
                                      rows={2}
                                      value={cap.text || ""}
                                      onChange={(e) =>
                                        patchCaptionLocal(cap.id, {
                                          text: e.target.value,
                                        })
                                      }
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
                                className="btn btn--sm"
                                onClick={generateCaptions}
                                disabled={captionsBusy}
                              >
                                {captionsBusy
                                  ? "Generating…"
                                  : "Regenerate from transcript"}
                              </button>
                              <button
                                type="button"
                                className="btn btn--sm btn--primary"
                                onClick={persistCaptions}
                              >
                                Save captions
                              </button>
                            </div>
                          </>
                        )}
                      </div>
                    )}
                  </div>
                </div>
              )}
            </>
          )}
        </main>
      </div>
    </div>
  );
}
