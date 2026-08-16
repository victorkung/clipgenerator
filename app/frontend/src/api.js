const BASE = "";

async function req(path, opts = {}) {
  const res = await fetch(`${BASE}${path}`, {
    headers: { "Content-Type": "application/json", ...(opts.headers || {}) },
    ...opts,
  });
  if (!res.ok) {
    let detail = res.statusText;
    try {
      const j = await res.json();
      detail = j.detail || JSON.stringify(j);
    } catch {
      /* ignore */
    }
    throw new Error(typeof detail === "string" ? detail : JSON.stringify(detail));
  }
  if (res.status === 204) return null;
  return res.json();
}

export const api = {
  health: () => req("/api/health"),
  listSources: () => req("/api/sources"),
  getSource: (id) => req(`/api/sources/${id}`),
  getTranscript: (id) => req(`/api/sources/${id}/transcript`),
  getJob: (id) => req(`/api/sources/${id}/job`),
  deleteSource: (id) => req(`/api/sources/${id}`, { method: "DELETE" }),
  updateSource: (id, body) =>
    req(`/api/sources/${id}`, { method: "PATCH", body: JSON.stringify(body) }),
  ingest: (body) => req("/api/ingest", { method: "POST", body: JSON.stringify(body) }),
  retryTranscribe: (sourceId, model) =>
    req(
      `/api/sources/${sourceId}/retry-transcribe${
        model ? `?model=${encodeURIComponent(model)}` : ""
      }`,
      { method: "POST" }
    ),
  retryDownload: (sourceId, model) =>
    req(
      `/api/sources/${sourceId}/retry-download${
        model ? `?model=${encodeURIComponent(model)}` : ""
      }`,
      { method: "POST" }
    ),
  rebuildAudio: (sourceId) =>
    req(`/api/sources/${sourceId}/rebuild-audio`, { method: "POST" }),
  createClip: (sourceId, body) =>
    req(`/api/sources/${sourceId}/clips`, { method: "POST", body: JSON.stringify(body) }),
  updateClip: (sourceId, clipId, body) =>
    req(`/api/sources/${sourceId}/clips/${clipId}`, {
      method: "PATCH",
      body: JSON.stringify(body),
    }),
  deleteClip: (sourceId, clipId) =>
    req(`/api/sources/${sourceId}/clips/${clipId}`, { method: "DELETE" }),
  generateCaptions: (sourceId, clipId) =>
    req(`/api/sources/${sourceId}/clips/${clipId}/captions/generate`, {
      method: "POST",
    }),
  saveCaptions: (sourceId, clipId, captions) =>
    req(`/api/sources/${sourceId}/clips/${clipId}/captions`, {
      method: "PUT",
      body: JSON.stringify({ captions }),
    }),
  exportClips: (sourceId, clipIds = null, opts = {}) =>
    req(`/api/sources/${sourceId}/export`, {
      method: "POST",
      body: JSON.stringify({
        clip_ids: clipIds,
        caption_style: opts.captionStyle ?? undefined,
        burn_captions: opts.burnCaptions !== false,
      }),
    }),
  getExportJob: (jobId) => req(`/api/export/${jobId}`),
  // Agent / social publish are not in this public editor build.
  agentsStatus: () => Promise.resolve({ xai: { configured: false } }),
  runSummaryAgent: () =>
    Promise.reject(new Error("Agents are not included in Clipgenerator-Public")),
  getAgentJob: () => Promise.reject(new Error("Agents are not included in Clipgenerator-Public")),
  approveSummary: () =>
    Promise.reject(new Error("Agents are not included in Clipgenerator-Public")),
  runClipsAgent: () =>
    Promise.reject(new Error("Agents are not included in Clipgenerator-Public")),
  approveClips: () =>
    Promise.reject(new Error("Agents are not included in Clipgenerator-Public")),
  runWriterAgent: () =>
    Promise.reject(new Error("Agents are not included in Clipgenerator-Public")),
  patchWriter: () =>
    Promise.reject(new Error("Agents are not included in Clipgenerator-Public")),
  approveWriter: () =>
    Promise.reject(new Error("Agents are not included in Clipgenerator-Public")),
  runCaptionsAgent: () =>
    Promise.reject(new Error("Agents are not included in Clipgenerator-Public")),
  runReplyAgent: () =>
    Promise.reject(new Error("Agents are not included in Clipgenerator-Public")),
  patchReply: () =>
    Promise.reject(new Error("Agents are not included in Clipgenerator-Public")),
  exportSummaryPackage: () =>
    Promise.reject(new Error("Agent packages are not included in Clipgenerator-Public")),
  exportClipPackage: () =>
    Promise.reject(new Error("Agent packages are not included in Clipgenerator-Public")),
  importClipPlan: () =>
    Promise.reject(new Error("Clip-plan import is not included in Clipgenerator-Public")),
  revealPath: (path) =>
    req("/api/reveal-path", {
      method: "POST",
      body: JSON.stringify({ path }),
    }),
  /** Same Pillow plate as export burn-in — use for monitor preview parity. */
  captionPlatePreview: (body) =>
    req("/api/caption-plate-preview", {
      method: "POST",
      body: JSON.stringify(body),
    }),
  mediaUrl: (absPath, bust) => {
    const q = new URLSearchParams({ path: absPath });
    if (bust) q.set("v", String(bust));
    return `/api/media?${q}`;
  },
};

export function formatTs(seconds) {
  if (seconds == null || Number.isNaN(seconds)) return "0:00";
  const s = Math.max(0, Math.floor(seconds));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  if (h > 0) return `${h}:${String(m).padStart(2, "0")}:${String(sec).padStart(2, "0")}`;
  return `${m}:${String(sec).padStart(2, "0")}`;
}
