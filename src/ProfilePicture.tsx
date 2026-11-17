import { useEffect, useRef, useState } from "react";
import { api, getCsrf } from "./api";

type PictureStatus = {
  picture: { id: string; url: string } | null;
  uploadAvailable: boolean;
};

type UploadPhase = "preparing" | "uploading" | "checking";

export function ProfilePicture() {
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
      if (mounted.current) setUploadPhase("checking");
      await api(`/profile/picture/${initial.id}/complete`, "POST", {});
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
    checking: "Upload complete. Checking your picture for safety…",
  }[uploadPhase];

  return (
    <section
      className="profile-picture-settings"
      aria-label="Your profile picture"
    >
      <h2>Profile picture</h2>
      <p>
        Your picture is private. After ten qualifying messages each in a quick
        chat, you can choose to show it to that person.
      </p>
      {loading ? (
        <p className="profile-picture-progress" role="status">
          <span className="profile-picture-spinner" aria-hidden="true" />
          <span>Loading your saved picture…</span>
        </p>
      ) : status?.picture ? (
        <div className="profile-picture-preview-shell">
          {!pictureLoadError && (
            <img
              className="profile-picture-preview"
              src={`${status.picture.url}?pictureId=${encodeURIComponent(status.picture.id)}&v=${encodeURIComponent(`${status.picture.id}-${pictureRetry}`)}`}
              alt="Your private profile picture"
              onLoad={() => setPictureLoading(false)}
              onError={() => {
                setPictureLoading(false);
                setPictureLoadError(true);
              }}
            />
          )}
          {pictureLoading && !pictureLoadError && (
            <div className="profile-picture-preview-loading" role="status">
              <span className="profile-picture-spinner" aria-hidden="true" />
              <span>Loading picture…</span>
            </div>
          )}
          {pictureLoadError && (
            <div className="profile-picture-preview-error" role="alert">
              <span>Couldn’t load your picture preview.</span>
              <button
                type="button"
                className="text-button"
                onClick={retryPicturePreview}
              >
                Retry
              </button>
            </div>
          )}
        </div>
      ) : (
        <p className="muted">No profile picture saved.</p>
      )}
      {status?.uploadAvailable && (
        <label className="profile-picture-upload">
          {busy
            ? "Saving profile picture…"
            : status.picture
              ? "Replace profile picture"
              : "Add profile picture"}
          <input
            type="file"
            accept="image/jpeg,image/png,image/webp"
            disabled={busy}
            onChange={(event) => {
              const file = event.currentTarget.files?.[0];
              event.currentTarget.value = "";
              if (file) void upload(file);
            }}
          />
          <small>
            JPEG, PNG or WebP, up to 5 MB. Your picture is checked before it is
            saved.
          </small>
        </label>
      )}
      {status && !status.uploadAvailable && (
        <p className="muted">Picture uploads are currently unavailable.</p>
      )}
      {busy && (
        <p
          className="profile-picture-progress"
          role="status"
          aria-live="polite"
        >
          <span className="profile-picture-spinner" aria-hidden="true" />
          <span>{uploadStatus}</span>
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
    </section>
  );
}
