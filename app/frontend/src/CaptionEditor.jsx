import { memo, useEffect, useRef, useState } from "react";
import { api, formatTs } from "./api";

/**
 * Own notebook for cue text. App's video clock must not rebuild these fields.
 * Parent only resets us when the clip or a fresh Generate changes.
 */
function CaptionEditor({
  sourceId,
  clipId,
  tIn,
  captions,
  captionsRev,
  captionsStale,
  activeCaptionId,
  captionsBusy,
  captionsCleaning,
  handlersRef,
}) {
  const [draft, setDraft] = useState(() => captions || []);
  const [msg, setMsg] = useState(null);
  const draftRef = useRef(draft);
  const focusedRef = useRef(false);

  useEffect(() => {
    const next = captions || [];
    setDraft(next);
    draftRef.current = next;
    handlersRef.current?.onDraftChange?.(next);
    setMsg(null);
    // captions is read only when clip / generate revision changes
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [clipId, captionsRev]);

  function setDraftAndNotify(next) {
    draftRef.current = next;
    handlersRef.current?.onDraftChange?.(next);
    setDraft(next);
  }

  function patchText(capId, text) {
    setDraftAndNotify(
      draftRef.current.map((c) => (c.id === capId ? { ...c, text } : c))
    );
  }

  async function persist() {
    if (!sourceId || !clipId) return;
    try {
      const updated = await api.saveCaptions(
        sourceId,
        clipId,
        draftRef.current
      );
      handlersRef.current?.onClipPatched?.(updated);
      return updated;
    } catch (err) {
      handlersRef.current?.onError?.(String(err.message || err));
    }
  }

  async function removeCue(capId) {
    if (!sourceId || !clipId) return;
    const next = draftRef.current.filter((c) => c.id !== capId);
    setDraftAndNotify(next);
    try {
      const updated = await api.saveCaptions(sourceId, clipId, next);
      handlersRef.current?.onClipPatched?.(updated);
    } catch (err) {
      handlersRef.current?.onError?.(String(err.message || err));
    }
  }

  if (!clipId) {
    return (
      <div className="paper">
        <div className="paper__body">
          <p className="transcript__empty">Select a clip first.</p>
        </div>
      </div>
    );
  }

  if (!draft.length) {
    return (
      <div className="paper">
        <div className="paper__body">
          <div className="caption-empty">
            <p className="caption-empty__hint">
              Captions are built from the source transcript for this clip&apos;s
              in/out. Scrub the <strong>source</strong> video; cue times are
              0-based so they match export. Style the plate in craft (font,
              cream/night, position). Export burns the plate when cues exist and
              always writes an .srt sidecar.
            </p>
            <button
              type="button"
              className="btn btn--primary"
              onClick={() => handlersRef.current?.onGenerate?.()}
              disabled={captionsBusy || captionsCleaning}
            >
              {captionsBusy
                ? "Generating…"
                : captionsCleaning
                  ? "Generating…"
                  : "Generate captions"}
            </button>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="paper">
      <div className="paper__body">
        {captionsCleaning && (
          <div className="caption-stale" role="status">
            Generating captions from the source transcript. Lines are editable.
            finishes unless you are typing.
          </div>
        )}
        {captionsStale && !captionsCleaning && (
          <div className="caption-stale">
            You moved the in point after these were written. Regenerate, or the
            SRT will sit off the picture.
          </div>
        )}
        <div className="caption-legend">
          <span>Click a line to edit · 0:00 = first frame of the export</span>
          <span>time button seeks the source</span>
        </div>
        <ul className="caption-list">
          {draft.map((cap) => {
            const active = activeCaptionId && activeCaptionId === cap.id;
            return (
              <li
                key={cap.id}
                className={`caption-row ${active ? "caption-row--active" : ""}`}
              >
                <button
                  type="button"
                  className="caption-row__seek"
                  title="Seek to this cue on the source video"
                  onClick={() =>
                    handlersRef.current?.onSeek?.(
                      Number(tIn || 0) + Number(cap.start)
                    )
                  }
                >
                  {formatTs(cap.start)}
                </button>
                <textarea
                  className="caption-row__text"
                  rows={1}
                  value={cap.text || ""}
                  onFocus={() => {
                    focusedRef.current = true;
                    handlersRef.current?.onFocusChange?.(true);
                  }}
                  onChange={(e) => patchText(cap.id, e.target.value)}
                  onBlur={() => {
                    focusedRef.current = false;
                    handlersRef.current?.onFocusChange?.(false);
                    void persist();
                  }}
                  spellCheck
                />
                <button
                  type="button"
                  className="caption-row__remove"
                  title="Remove cue"
                  onClick={() => removeCue(cap.id)}
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
            className="btn btn--paper btn--sm"
            onClick={() => handlersRef.current?.onGenerate?.()}
            disabled={captionsBusy || captionsCleaning}
          >
            {captionsBusy
              ? "Generating…"
              : captionsCleaning
                ? "Generating…"
                : "Regenerate from transcript"}
          </button>
          <button
            type="button"
            className="btn btn--primary btn--sm"
            onClick={async () => {
              try {
                await persist();
                setMsg("Caption changes applied");
              } catch (err) {
                handlersRef.current?.onError?.(String(err.message || err));
              }
            }}
          >
            Apply changes
          </button>
          <p className="caption-note">
            Export burns the plate + writes .srt · style in craft → Caption plate
          </p>
        </div>
        {msg && (
          <p className="caption-note" role="status">
            {msg}
          </p>
        )}
      </div>
    </div>
  );
}

function sameCaptionEditorProps(prev, next) {
  return (
    prev.sourceId === next.sourceId &&
    prev.clipId === next.clipId &&
    prev.tIn === next.tIn &&
    prev.captionsRev === next.captionsRev &&
    prev.captionsStale === next.captionsStale &&
    prev.activeCaptionId === next.activeCaptionId &&
    prev.captionsBusy === next.captionsBusy &&
    prev.captionsCleaning === next.captionsCleaning
  );
}

export default memo(CaptionEditor, sameCaptionEditorProps);
