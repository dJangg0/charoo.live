import { Coins, Eye } from "lucide-react";

// Quick-chat disclosure (FR-12, FR-13). Profile pictures are shown at the profile
// milestone without a consent step; a paid peek is the only other early reveal.
export interface PictureReveal {
  eligible: boolean;
  participants: { id: string; url: string }[];
}

export interface PeekView {
  price: number;
  purchased: boolean;
  available: boolean;
  revealsAsl: boolean;
  revealsPicture: boolean;
}

export interface QuickChatThresholds {
  aslWords: number;
  pictureMessages: number;
}

type ProgressRow = { id: string; count: number };

function ProgressGroup({
  title,
  hint,
  userId,
  peerId,
  rows,
  target,
  unit,
}: {
  title: string;
  hint: string;
  userId: string;
  peerId: string;
  rows: ProgressRow[];
  target: number;
  unit: string;
}) {
  const people = [
    { id: userId, label: "You" },
    { id: peerId, label: "Stranger" },
  ];
  return (
    <div className="quick-chat-progress-group">
      <div className="quick-chat-progress-heading">
        <strong>{title}</strong>
        <span>{hint}</span>
      </div>
      <div className="quick-chat-progress-people">
        {people.map((person) => {
          const raw = rows.find((row) => row.id === person.id)?.count || 0;
          const count = Math.min(target, Math.max(0, raw));
          return (
            <div className="quick-chat-progress-person" key={person.id}>
              <div className="quick-chat-progress-label">
                <span>{person.label}</span>
                <span>
                  {count}/{target} {unit}
                </span>
              </div>
              <div
                className="quick-chat-progress-track"
                role="progressbar"
                aria-label={`${title}: ${person.label}`}
                aria-valuemin={0}
                aria-valuemax={target}
                aria-valuenow={count}
                aria-valuetext={`${count} of ${target} ${unit}`}
              >
                <span style={{ width: `${(count / target) * 100}%` }} />
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}

export function QuickChatProgress({
  userId,
  peerId,
  aslProgress,
  pictureProgress,
  thresholds,
}: {
  userId: string;
  peerId: string;
  aslProgress: ProgressRow[];
  pictureProgress: ProgressRow[];
  thresholds: QuickChatThresholds;
}) {
  return (
    <section className="quick-chat-progress" aria-label="Quick chat progress">
      <ProgressGroup
        title="Words"
        hint={`${thresholds.aslWords} each unlocks age, sex and location`}
        userId={userId}
        peerId={peerId}
        rows={aslProgress}
        target={thresholds.aslWords}
        unit="words"
      />
      <ProgressGroup
        title="Messages"
        hint={`${thresholds.pictureMessages} each shows profile pictures`}
        userId={userId}
        peerId={peerId}
        rows={pictureProgress}
        target={thresholds.pictureMessages}
        unit="messages"
      />
    </section>
  );
}

function revealList(peek: PeekView) {
  const parts = [
    peek.revealsAsl ? "age, sex and location" : "",
    peek.revealsPicture ? "their profile picture" : "",
  ].filter(Boolean);
  return parts.join(" and ");
}

export function QuickChatDisclosure({
  userId,
  pictureReveal,
  peek,
  balance,
  peekPending,
  onPeek,
  onOpenCredits,
}: {
  userId: string;
  pictureReveal?: PictureReveal;
  peek?: PeekView;
  balance: number | null;
  peekPending: boolean;
  onPeek: (peek: PeekView) => void;
  onOpenCredits: () => void;
}) {
  const shown =
    pictureReveal?.participants.filter((p) => p.id !== userId) ?? [];
  const showPeek = !!peek && (peek.available || peek.purchased || peekPending);
  if (!pictureReveal?.eligible && !shown.length && !showPeek) return null;

  return (
    <section
      className="quick-chat-disclosure picture-sharing-notice"
      aria-label="Quick chat disclosure"
    >
      {pictureReveal?.eligible && (
        <p className="picture-sharing-milestone" role="status">
          <Eye size={17} aria-hidden="true" />
          <strong>Profile pictures are shown in this chat.</strong>
        </p>
      )}
      {shown.map((person) => (
        <figure className="shared-profile-picture" key={person.id}>
          <figcaption>Your partner’s profile picture</figcaption>
          <img src={person.url} alt="Your partner’s profile picture" />
        </figure>
      ))}
      {pictureReveal?.eligible && !shown.length && (
        <p className="muted">Your partner has no profile picture to show.</p>
      )}
      {showPeek && peek && (
        <div className="peek-panel" aria-live="polite">
          {peekPending ? (
            <p className="peek-status" role="status">
              <span className="peek-spinner" aria-hidden="true" />
              Revealing… this clears when the chat confirms it.
            </p>
          ) : peek.purchased ? (
            <p className="peek-status" role="status">
              <Coins size={17} aria-hidden="true" />
              You peeked at {revealList(peek) || "this partner"}. Only you can
              see this; they were not notified.
            </p>
          ) : (
            <>
              <p>
                <strong>Peek now for {peek.price} credits.</strong> This reveals{" "}
                {revealList(peek)} to you only. Your partner isn’t notified.
              </p>
              {balance !== null && balance < peek.price ? (
                <div className="peek-actions">
                  <p className="muted">
                    You need {peek.price - balance} more credits to peek.
                  </p>
                  <button
                    type="button"
                    className="button secondary small"
                    onClick={onOpenCredits}
                  >
                    Get credits
                  </button>
                </div>
              ) : (
                <div className="peek-actions">
                  <button
                    type="button"
                    className="button small"
                    onClick={() => onPeek(peek)}
                  >
                    Peek for {peek.price} credits
                  </button>
                </div>
              )}
            </>
          )}
        </div>
      )}
    </section>
  );
}
