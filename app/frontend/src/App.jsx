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
  const [captionsBusy, setCaptionsBusy] = useState(false);
  const [rightPane, setRightPane] = useState("transcript"); // transcript | captions
  const [inDraft, setInDraft] = useState("");
  const [outDraft, setOutDraft] = useState("");
  const [titleDraft, setTitleDraft] = useState("");
  const [editingTitle, setEditingTitle] = useState(false);
  const videoRef = useRef(null);
  const titleInputRef = useRef(null);
  /** Source the user is viewing — kept in a ref so async export can check without stale closure. */
  const selectedIdRef = useRef(selectedId);
  /** Source that owns the in-flight export UI (progress / success). */
  const exportOwnerIdRef = useRef(null);

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
    selectedIdRef.current = selectedId;
    // Export banners are scoped to the source that ran them — drop when switching videos
    setExportMsg(null);
    setExportPercent(null);
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

  const segments = transcript?.segments || [];

  const activeSegIndex = useMemo(() => {
    if (!segments.length) return -1;
    const exact = segments.findIndex(
      (s) => currentTime >= s.start && currentTime < (s.end || s.start + 0.01)
    );
    if (exact >= 0) return exact;
    // Between / past segments (common after typing a time): nearest started line
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

  async function generateCaptions() {
    if (!source || !activeClip || captionsBusy) return;
    setError(null);
    setCaptionsBusy(true);
    try {
      const updated = await api.generateCaptions(source.id, activeClip.id);
      setSource((prev) => ({
        ...prev,
        clips: (prev.clips || []).map((c) =>
          c.id === updated.id ? { ...c, ...updated } : c
        ),
      }));
      setRightPane("captions");
      setExportMsg(
        `Captions ready — ${updated.captions?.length || 0} line(s) for “${updated.title || "clip"}” (times relative to clip start)`
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
    setExportMsg(label || "Starting export…");
    try {
      const started = await api.exportClips(ownerId, clipIds);
      const jobId = started.job_id;
      if (!jobId) throw new Error("export did not return a job id");

      // Poll ffmpeg progress until done/error (UI updates only while still on this source)
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
        }
      } else if (onOwner()) {
        setExportPercent(100);
        setExportMsg(
          `✓ ${job.message || `Exported ${n} clip(s)`}` +
            (job.out_dir ? `\n${job.out_dir}` : "") +
            (job.errors?.length
              ? `\n(${job.errors.length} failed: ${job.errors.join("; ")})`
              : "")
        );
      }
      // Only reload the open source if still viewing the exporter; always refresh sidebar
      if (onOwner()) await loadSource(ownerId);
      await refreshList();
    } catch (err) {
      if (onOwner()) {
        setError(String(err.message || err));
        setExportMsg(null);
        setExportPercent(null);
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

    // If start moves past end (common when typing a new start while end is still 0:30),
    // keep a sensible duration instead of hard-failing.
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
    // Seek first so video + transcript jump immediately; then persist.
    const seekT =
      seekField === "out" ? Math.max(t_in, t_out - 0.25) : t_in;
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

  const mediaSrc =
    source?.video_path && source.status === "ready"
      ? api.mediaUrl(source.video_path)
      : null;

  const inRange =
    activeClip &&
    currentTime >= activeClip.t_in &&
    currentTime <= activeClip.t_out;

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

  return (
    <div className="app">
      <header className="top">
        <div className="brand">
          <div className="brand-mark">cg</div>
          <div className="brand__text">
            <span className="brand__name">clipgenerator</span>
            <span className="brand__tag">local · multi-clip · whisper</span>
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
            <button type="submit" className="btn btn--primary" disabled={busy}>
              {busy ? "Starting…" : "Ingest"}
            </button>
          </div>
          <p className="ingest__hint" aria-live="polite">
            {WHISPER_MODELS.find((m) => m.id === model)?.guide}
          </p>
        </form>
      </header>

      {error && (
        <div className="banner banner--error" onClick={() => setError(null)}>
          {error}
        </div>
      )}

      <div className="layout">
        <aside className="sidebar">
          <div className="section-label">
            <h2 className="section-label__title">Sources</h2>
            <span className="section-label__count">{sources.length}</span>
          </div>
          <ul className="sidebar__list">
            {sources.map((s) => (
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
              <div className="empty-main__icon">▶</div>
              <h1 className="text-display">Cut clips from long videos</h1>
              <p className="text-meta">
                Paste a YouTube or X URL to download, transcribe on-device, then mark in/out
                points with a live transcript.
              </p>
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

              {source.status !== "ready" && source.status !== "error" && (
                <PipelineProgress source={source} />
              )}

              {source.status === "ready" && mediaSrc && (
                <div className="workspace">
                  <div className="player-col">
                    <div className="video-shell">
                      <video
                        ref={videoRef}
                        src={mediaSrc}
                        controls
                        onTimeUpdate={(e) => setCurrentTime(e.target.currentTime)}
                      />
                      {activeCaption?.text && (
                        <div className="caption-overlay" aria-live="polite">
                          <span className="caption-overlay__text">
                            {activeCaption.text}
                          </span>
                        </div>
                      )}
                    </div>

                    <div className="panel clip-bar">
                      <div className="clip-bar__top">
                        <label className="field field--grow">
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
                        {activeClip && (
                          <div className={`range-chip ${inRange ? "range-chip--in" : ""}`}>
                            {formatTs(activeClip.t_in)} → {formatTs(activeClip.t_out)}
                            <span className="text-secondary">
                              {" "}
                              · {Math.max(0, activeClip.t_out - activeClip.t_in).toFixed(1)}s
                            </span>
                          </div>
                        )}
                      </div>

                      <div className="clip-bar__row">
                        <label className="field">
                          <span className="field__label">Start</span>
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
                            title="Enter a time — player and transcript jump here"
                          />
                        </label>
                        <label className="field">
                          <span className="field__label">End</span>
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
                            title="Enter a time — player and transcript jump near end"
                          />
                        </label>
                        <button
                          type="button"
                          className="btn btn--sm"
                          onClick={() => applyTypedTimes({ seek: "in" })}
                          disabled={!activeClip}
                          title="Apply times and jump player to start"
                        >
                          Apply
                        </button>
                      </div>

                      <div className="clip-bar__row">
                        <button
                          type="button"
                          className="btn btn--primary"
                          onClick={setInFromPlayhead}
                          disabled={!activeClip}
                        >
                          Set start @ {formatTs(currentTime)}
                        </button>
                        <button
                          type="button"
                          className="btn btn--primary"
                          onClick={setOutFromPlayhead}
                          disabled={!activeClip}
                        >
                          Set end @ {formatTs(currentTime)}
                        </button>
                        <button
                          type="button"
                          className="btn"
                          onClick={() => activeClip && seekTo(activeClip.t_in)}
                          disabled={!activeClip}
                        >
                          Jump start
                        </button>
                        <button
                          type="button"
                          className="btn"
                          onClick={() =>
                            activeClip && seekTo(Math.max(0, (activeClip.t_out || 0) - 1))
                          }
                          disabled={!activeClip}
                        >
                          Jump end
                        </button>
                      </div>

                      <div className="clip-bar__row">
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
                          className="btn"
                          onClick={exportAll}
                          disabled={exportBusy}
                        >
                          Export all
                        </button>
                        <button
                          type="button"
                          className="btn"
                          onClick={addClip}
                          disabled={exportBusy}
                        >
                          + New clip
                        </button>
                        <button
                          type="button"
                          className="btn"
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
                            className="btn btn--ghost"
                            onClick={() => setRightPane("captions")}
                          >
                            Edit captions ({clipCaptions.length})
                          </button>
                        )}
                      </div>
                      {exportMsg && (
                        <div
                          className={`export-status ${
                            exportBusy
                              ? "export-status--busy"
                              : "export-status--done"
                          }`}
                          role="status"
                          aria-live="polite"
                          onClick={() => !exportBusy && setExportMsg(null)}
                        >
                          <div className="export-status__row">
                            {exportBusy && <span className="banner__spinner" />}
                            <span className="export-status__text">
                              {exportMsg}
                              {exportBusy && exportPercent != null && (
                                <span className="banner__pct">
                                  {" "}
                                  · {exportPercent}%
                                </span>
                              )}
                            </span>
                            {!exportBusy && (
                              <span className="banner__dismiss">click to dismiss</span>
                            )}
                          </div>
                          {exportBusy && exportPercent != null && (
                            <div className="banner__track" aria-hidden>
                              <div
                                className="banner__fill"
                                style={{
                                  width: `${Math.min(100, Math.max(2, exportPercent))}%`,
                                }}
                              />
                            </div>
                          )}
                        </div>
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

                    <div className="clip-list">
                      <div className="section-label">
                        <h3 className="section-label__title">Clips</h3>
                        <span className="section-label__count">
                          {(source.clips || []).length}
                        </span>
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
                                {(c.captions || []).length > 0
                                  ? ` · ${c.captions.length} cap`
                                  : ""}
                              </span>
                            </div>
                            <span className={pillStatus(c.status)}>{c.status}</span>
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
                        <span className="text-meta" title="⌥ click start · ⇧ click end">
                          ⌥ start · ⇧ end
                        </span>
                      ) : (
                        <span className="text-meta" title="Times are relative to clip start">
                          clip-relative · 0:00 = start
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
                              in/out range. You still scrub the source video; cue times are
                              0-based so they match the exported file.
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
                                {captionsBusy ? "Generating…" : "Regenerate from transcript"}
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
