import { Eye } from "lucide-react";
import { QUICK_CHAT_DISCLOSURE_WORDS } from "@charoo/contracts";

export interface PictureSharing {
  eligible: boolean;
  self: {
    hasPicture: boolean;
    decision: "pending" | "declined" | "approved";
    pictureId?: string | null;
    previewUrl?: string | null;
  };
  participants: { id: string; url: string }[];
}

export function QuickChatProgress({
  userId,
  progress,
}: {
  userId: string;
  progress: { id: string; count: number }[];
}) {
  const people = [
    { id: userId, label: "You" },
    {
      id: progress.find((person) => person.id !== userId)?.id || "peer",
      label: "Stranger",
    },
  ];

  return (
    <section className="quick-chat-progress" aria-label="Quick chat progress">
      <div className="quick-chat-progress-heading">
        <strong>Chat progress</strong>
        <span>{QUICK_CHAT_DISCLOSURE_WORDS} words each to unlock sharing</span>
      </div>
      <div className="quick-chat-progress-people">
        {people.map((person) => {
          const count = Math.min(
            QUICK_CHAT_DISCLOSURE_WORDS,
            Math.max(
              0,
              progress.find((item) => item.id === person.id)?.count || 0,
            ),
          );
          return (
            <div className="quick-chat-progress-person" key={person.id}>
              <div className="quick-chat-progress-label">
                <span>{person.label}</span>
                <span>
                  {count}/{QUICK_CHAT_DISCLOSURE_WORDS}
                </span>
              </div>
              <div
                className="quick-chat-progress-track"
                role="progressbar"
                aria-label={person.label}
                aria-valuemin={0}
                aria-valuemax={QUICK_CHAT_DISCLOSURE_WORDS}
                aria-valuenow={count}
                aria-valuetext={`${count} of ${QUICK_CHAT_DISCLOSURE_WORDS} words`}
              >
                <span
                  style={{
                    width: `${(count / QUICK_CHAT_DISCLOSURE_WORDS) * 100}%`,
                  }}
                />
              </div>
            </div>
          );
        })}
      </div>
    </section>
  );
}

export function QuickChatDisclosure({
  userId,
  aslRevealed,
  participants,
  sharing,
  busy,
  onDecision,
}: {
  userId: string;
  aslRevealed: boolean;
  participants: {
    id: string;
    asl?: { age: number | null; gender: string; region: string } | null;
  }[];
  sharing?: PictureSharing;
  busy: boolean;
  onDecision: (decision: "approved" | "declined", pictureId?: string) => void;
}) {
  const asl = aslRevealed
    ? participants.flatMap((person) => {
        const values = person.asl
          ? [
              person.asl.age ? `Age ${person.asl.age}` : "",
              person.asl.gender ? `Sex ${person.asl.gender}` : "",
              person.asl.region ? `Location ${person.asl.region}` : "",
            ].filter(Boolean)
          : [];
        return values.length
          ? [
              {
                id: person.id,
                label: person.id === userId ? "You" : "Stranger",
                values,
              },
            ]
          : [];
      })
    : [];
  if (!asl.length && !sharing?.eligible) return null;

  return (
    <div className="quick-chat-disclosure" aria-label="Quick chat sharing">
      {asl.map((person) => (
        <p className="disclosure-asl" key={person.id}>
          <strong>{person.label}:</strong> {person.values.join(" · ")}
        </p>
      ))}
      {sharing?.eligible && (
        <section
          className="picture-sharing-notice"
          aria-label="Profile picture sharing"
        >
          <p className="picture-sharing-milestone" role="status">
            <Eye size={17} aria-hidden="true" />
            <strong>Picture sharing is now available.</strong>
          </p>
          {!sharing.self.hasPicture ? (
            <p>
              You don’t have a profile picture to share. Your picture stays
              hidden.
            </p>
          ) : sharing.self.decision === "approved" ? (
            <p>You chose to show your profile picture in this chat.</p>
          ) : (
            <div className="picture-sharing-choice">
              {sharing.self.previewUrl && (
                <img
                  className="consent-picture-preview"
                  src={sharing.self.previewUrl}
                  alt="The profile picture you can choose to share"
                />
              )}
              <p>
                {sharing.self.decision === "declined"
                  ? "You can show your profile picture whenever you want."
                  : "Would you like to show your profile picture to this person? Only your picture will be shared, in this chat."}
              </p>
              <div className="picture-sharing-actions">
                <button
                  type="button"
                  className="button small"
                  disabled={busy}
                  onClick={() =>
                    onDecision("approved", sharing.self.pictureId || undefined)
                  }
                >
                  Show my profile picture
                </button>
                {sharing.self.decision === "pending" && (
                  <button
                    type="button"
                    className="button secondary small"
                    disabled={busy}
                    onClick={() => onDecision("declined")}
                  >
                    Not now
                  </button>
                )}
              </div>
            </div>
          )}
          {sharing.participants
            .filter((person) => person.id !== userId)
            .map((person) => (
              <figure className="shared-profile-picture" key={person.id}>
                <figcaption role="status">
                  Stranger chose to show you their profile picture.
                </figcaption>
                <img src={person.url} alt="Stranger’s shared profile picture" />
              </figure>
            ))}
        </section>
      )}
    </div>
  );
}
