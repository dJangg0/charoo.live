import type { AvatarId } from "@charoo/contracts";

// Generated in-app avatars: simple shapes drawn here, with no downloaded artwork.
export const AVATAR_LABELS: Record<AvatarId, string> = {
  sky: "Sky",
  sun: "Sun",
  mint: "Mint",
  rose: "Rose",
  violet: "Violet",
  ember: "Ember",
  slate: "Slate",
  moss: "Moss",
};
const AVATAR_COLORS: Record<AvatarId, string> = {
  sky: "#7dd3fc",
  sun: "#fde047",
  mint: "#6ee7b7",
  rose: "#fda4af",
  violet: "#c4b5fd",
  ember: "#fdba74",
  slate: "#cbd5e1",
  moss: "#bef264",
};

// What a room member displays: a generated avatar, their pinned picture, or nothing usable.
export type MemberAvatar =
  | { kind: "avatar"; id: AvatarId }
  | { kind: "picture"; url: string }
  | null
  | undefined;

export function Avatar({
  avatar,
  name,
  size = 42,
}: {
  avatar: MemberAvatar;
  name: string;
  size?: number;
}) {
  if (avatar?.kind === "picture")
    return (
      <img
        className="avatar avatar-photo"
        src={avatar.url}
        alt={`${name}’s profile picture`}
        width={size}
        height={size}
      />
    );
  const id: AvatarId = avatar?.kind === "avatar" ? avatar.id : "sky";
  return (
    <svg
      className="avatar avatar-generated"
      viewBox="0 0 64 64"
      width={size}
      height={size}
      role="img"
      aria-label={`${name}’s ${AVATAR_LABELS[id]} avatar`}
    >
      <circle cx="32" cy="32" r="32" fill={AVATAR_COLORS[id]} />
      <circle cx="32" cy="26" r="11" fill="rgba(0,0,0,0.55)" />
      <path d="M12 58c3-11 11-16 20-16s17 5 20 16z" fill="rgba(0,0,0,0.55)" />
    </svg>
  );
}
