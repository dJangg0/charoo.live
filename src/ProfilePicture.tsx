import { useEffect, useId, useRef, useState, type ReactNode } from "react";
import { Camera } from "lucide-react";
import { api, getCsrf } from "./api";

type PictureStatus = {
  picture: { id: string; url: string } | null;
  uploadAvailable: boolean;
};

type UploadPhase = "preparing" | "uploading" | "saving";

export function ProfilePicture({
  displayName,
  children,
}: {
  displayName: string;
  children: ReactNode;
}) {
  const [status, setStatus] = useState<PictureStatus | null>(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [uploadPhase, setUploadPhase] = useState<UploadPhase>("preparing");
  const [pictureLoading, setPictureLoading] = useState(false);
  const [pictureLoadError, setPictureLoadError] = useState(false);
  const [pictureRetry, setPictureRetry] = useState(0);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const mounted = useRef(true);
  const picker = useRef<HTMLInputElement>(null);
  const helpId = useId();

  async function load() {
    const next = await api<PictureStatus>("/profile/picture");
    if (mounted.current) {
      setStatus(next);
      setPictureLoadError(false);
      setPictureLoading(!!next.picture);
    }
  }

  useEffect(() => {
    mounted.current = true;
    load()
      .catch((e: Error) => {
        if (mounted.current) setError(e.message);
      })
      .finally(() => {
        if (mounted.current) setLoading(false);
      });
    return () => {
      mounted.current = false;
    };
  }, []);

  async function upload(file: File) {
    setBusy(true);
    setUploadPhase("preparing");
    setError("");
    setNotice("");
    setPictureLoadError(false);
    try {
      if (!["image/jpeg", "image/png", "image/webp"].includes(file.type))
        throw new Error("Choose a JPEG, PNG or WebP picture.");
      if (!file.size || file.size > 5 * 1048576)
        throw new Error("Choose a picture up to 5 MB.");
      const initial = await api<{ id: string; url: string }>(
        "/profile/picture/init",
        "POST",
        { mime: file.type, size: file.size },
      );
      if (mounted.current) setUploadPhase("uploading");
      const response = await fetch(initial.url, {
        method: "PUT",
        credentials: "include",
        headers: {
          "Content-Type": file.type,
          "X-CSRF-Token": getCsrf(),
        },
        body: file,
      });
      if (!response.ok) {
        const result = await response.json().catch(() => ({}));
        throw new Error(
          result.error || "Picture upload failed. Please try again.",
        );
      }
      if (mounted.current) setUploadPhase("saving");
      const completed = await api<{ id: string; state: string }>(
        `/profile/picture/${initial.id}/complete`,
        "POST",
        {},
      );
      if (completed.id !== initial.id || completed.state !== "APPROVED")
        throw new Error("Your picture could not be saved. Please try again.");
      await load();
      if (mounted.current)
        setNotice(
          "Profile picture saved. You choose whether to share it in each quick chat.",
        );
    } catch (e) {
      if (mounted.current) setError((e as Error).message);
    } finally {
      if (mounted.current) setBusy(false);
    }
  }

  const retryPicturePreview = () => {
    setPictureLoadError(false);
    setPictureLoading(true);
    setPictureRetry((attempt) => attempt + 1);
  };

  const uploadStatus = {
    preparing: "Preparing your picture upload…",
    uploading: "Uploading your picture…",
    saving: "Confirming your picture…",
  }[uploadPhase];

  return (
    <div className="profile-status">
      <div
        className="profile-avatar-editor"
        role="group"
        aria-label="Your profile picture"
      >
        <button
          type="button"
          className="avatar large profile-avatar-button"
          aria-label={
            status?.picture
              ? "Change profile picture"
              : "Upload profile picture"
          }
          aria-describedby={helpId}
          aria-busy={busy}
          disabled={loading || busy || !status?.uploadAvailable}
          onClick={() => picker.current?.click()}
        >
          {status?.picture && !pictureLoadError ? (
            <img
              className="profile-picture-preview"
              src={`${status.picture.url}?v=${encodeURIComponent(`${status.picture.id}-${pictureRetry}`)}`}
              alt="Your private profile picture"
              onLoad={() => setPictureLoading(false)}
              onError={() => {
                setPictureLoading(false);
                setPictureLoadError(true);
              }}
            />
          ) : (
            <span aria-hidden="true">
              {displayName[0]?.toUpperCase() || "?"}
            </span>
          )}
          <span className="profile-avatar-camera" aria-hidden="true">
            <Camera size={14} />
          </span>
        </button>
        <span className="profile-avatar-caption" aria-hidden="true">
          {status?.picture ? "Change photo" : "Add photo"}
        </span>
        {status?.uploadAvailable && (
          <input
            ref={picker}
            type="file"
            hidden
            tabIndex={-1}
            aria-label={
              status.picture ? "Replace profile picture" : "Add profile picture"
            }
            accept="image/jpeg,image/png,image/webp"
            disabled={busy}
            onChange={(event) => {
              const file = event.currentTarget.files?.[0];
              event.currentTarget.value = "";
              if (file) void upload(file);
            }}
          />
        )}
      </div>
      {children}
      <div className="profile-picture-feedback">
        <p id={helpId} className="muted">
          Click your photo to upload or replace it. JPEG, PNG or WebP, up to 5
          MB. Your photo stays private until you choose to share it.
        </p>
        {loading && <p role="status">Loading your picture…</p>}
        {pictureLoading && !pictureLoadError && (
          <p role="status">Loading your saved picture…</p>
        )}
        {pictureLoadError && (
          <p role="alert">
            Couldn’t load your picture preview. {" "}
            <button
              type="button"
              className="text-button"
              onClick={retryPicturePreview}
            >
              Retry
            </button>
          </p>
        )}
        {status && !status.uploadAvailable && (
          <p className="muted">Picture uploads are currently unavailable.</p>
        )}
        {busy && (
          <p role="status" aria-live="polite">
            {uploadStatus}
          </p>
        )}
        {error && <p role="alert">{error}</p>}
        {error && !status && (
          <button
            type="button"
            className="button secondary small"
            disabled={loading}
            onClick={async () => {
              setLoading(true);
              setError("");
              try {
                await load();
              } catch (e) {
                if (mounted.current) setError((e as Error).message);
              } finally {
                if (mounted.current) setLoading(false);
              }
            }}
          >
            Retry loading picture
          </button>
        )}
        {notice && <p role="status">{notice}</p>}
      </div>
    </div>
  );
}
