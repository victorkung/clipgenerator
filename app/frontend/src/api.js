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
  exportClips: (sourceId, clipIds = null) =>
    req(`/api/sources/${sourceId}/export`, {
      method: "POST",
      body: JSON.stringify({ clip_ids: clipIds }),
    }),
  getExportJob: (jobId) => req(`/api/export/${jobId}`),
  exportSummaryPackage: (sourceId) =>
    req(`/api/sources/${sourceId}/agent-export/summary`, { method: "POST" }),
  exportClipPackage: (sourceId) =>
    req(`/api/sources/${sourceId}/agent-export/clip`, { method: "POST" }),
  importClipPlan: (sourceId, body) =>
    req(`/api/sources/${sourceId}/clip-plan/import`, {
      method: "POST",
      body: JSON.stringify(body),
    }),
  revealPath: (path) =>
    req("/api/reveal-path", {
      method: "POST",
      body: JSON.stringify({ path }),
    }),
  mediaUrl: (absPath) => `/api/media?path=${encodeURIComponent(absPath)}`,
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
