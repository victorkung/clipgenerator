import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { api, formatTs } from "./api";

const DEFAULT_STAGES = [
  { id: "queued", label: "Queued" },
  { id: "resolving", label: "Resolve" },
  { id: "downloading", label: "Download" },
  { id: "transcribing", label: "Transcribe" },
  { id: "done", label: "Ready" },
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
  const [inDraft, setInDraft] = useState("");
  const [outDraft, setOutDraft] = useState("");
  const [titleDraft, setTitleDraft] = useState("");
  const [editingTitle, setEditingTitle] = useState(false);
  const videoRef = useRef(null);
  const titleInputRef = useRef(null);

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
    return segments.findIndex(
      (s) => currentTime >= s.start && currentTime < (s.end || s.start + 0.01)
    );
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

  async function exportOne() {
    if (!source || !activeClip || exportBusy) return;
    setError(null);
    setExportBusy(true);
    setExportMsg(`Exporting “${activeClip.title || "clip"}”… encoding H.264 + AAC`);
    try {
      const r = await api.exportClips(source.id, [activeClip.id]);
      if (r.errors?.length) {
        setError(r.errors.join("; "));
        setExportMsg(null);
      } else {
        const path = r.exported?.[0]?.export_path || r.out_dir;
        setExportMsg(
          `✓ Export done — ${activeClip.title || "clip"} saved with audio.\n${path}`
        );
      }
      await loadSource(source.id);
    } catch (err) {
      setError(String(err.message || err));
      setExportMsg(null);
    } finally {
      setExportBusy(false);
    }
  }

  async function exportAll() {
    if (!source || exportBusy) return;
    setError(null);
    setExportBusy(true);
    setExportMsg("Exporting all clips… encoding H.264 + AAC");
    try {
      const r = await api.exportClips(source.id, null);
      const n = r.exported?.length || 0;
      if (r.errors?.length && !n) {
        setError(r.errors.join("; "));
        setExportMsg(null);
      } else {
        setExportMsg(
          `✓ Exported ${n} clip(s) with audio → ${r.out_dir}` +
            (r.errors?.length ? `\n(${r.errors.length} failed: ${r.errors.join("; ")})` : "")
        );
      }
      await loadSource(source.id);
    } catch (err) {
      setError(String(err.message || err));
      setExportMsg(null);
    } finally {
      setExportBusy(false);
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

  function applyTypedTimes() {
    if (!activeClip) return;
    const t_in = parseTsInput(inDraft);
    const t_out = parseTsInput(outDraft);
    if (t_in == null || t_out == null) {
      setError("Use times like 1:23 or 1:02:03");
      return;
    }
    if (t_out <= t_in) {
      setError("End must be after start");
      return;
    }
    saveClipPatch({ t_in, t_out });
  }

  function seekTo(t) {
    if (videoRef.current) {
      videoRef.current.currentTime = t;
      setCurrentTime(t);
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
            title="Faster models recommended for long pods"
          >
            <option value="small">small · fast</option>
            <option value="turbo">turbo · better</option>
            <option value="medium">medium · accurate</option>
            <option value="large-v3">large-v3 · slow</option>
          </select>
          <button type="submit" className="btn btn--primary" disabled={busy}>
            {busy ? "Starting…" : "Ingest"}
          </button>
        </form>
      </header>

      {error && (
        <div className="banner banner--error" onClick={() => setError(null)}>
          {error}
        </div>
      )}
      {exportMsg && (
        <div
          className={`banner ${exportBusy ? "banner--warning" : "banner--success"}`}
          onClick={() => !exportBusy && setExportMsg(null)}
        >
          {exportBusy && <span className="banner__spinner" />}
          <span className="banner__text">{exportMsg}</span>
          {!exportBusy && <span className="banner__dismiss">click to dismiss</span>}
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
                            onBlur={applyTypedTimes}
                            onKeyDown={(e) => e.key === "Enter" && applyTypedTimes()}
                            placeholder="0:00"
                            disabled={!activeClip}
                          />
                        </label>
                        <label className="field">
                          <span className="field__label">End</span>
                          <input
                            className="input input--mono"
                            value={outDraft}
                            onChange={(e) => setOutDraft(e.target.value)}
                            onBlur={applyTypedTimes}
                            onKeyDown={(e) => e.key === "Enter" && applyTypedTimes()}
                            placeholder="0:30"
                            disabled={!activeClip}
                          />
                        </label>
                        <button
                          type="button"
                          className="btn btn--sm"
                          onClick={applyTypedTimes}
                          disabled={!activeClip}
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
                          {exportBusy ? "Exporting…" : "Export clip"}
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
                      </div>
                      {activeClip?.status === "rendered" && activeClip?.export_path && (
                        <p className="export-path">
                          Saved · <code>{activeClip.export_path}</code>
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
                      <h3 className="section-label__title">Transcript</h3>
                      <span className="text-meta" title="⌥ click start · ⇧ click end">
                        ⌥ start · ⇧ end
                      </span>
                    </div>
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
