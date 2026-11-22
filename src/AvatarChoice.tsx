import { AVATAR_IDS, type AvatarChoice } from "@charoo/contracts";
import { Avatar, AVATAR_LABELS } from "./Avatar";

export function AvatarChoicePicker({
  value,
  onChange,
  hasPicture,
}: {
  value: AvatarChoice;
  onChange: (value: AvatarChoice) => void;
  hasPicture: boolean;
}) {
  return (
    <fieldset className="avatar-choice">
      <legend>How should others see you in this room?</legend>
      <label
        className={`avatar-option picture-option${hasPicture ? "" : " disabled"}`}
      >
        <input
          type="radio"
          name="avatar-choice"
          checked={value.kind === "picture"}
          disabled={!hasPicture}
          onChange={() => onChange({ kind: "picture" })}
        />
        <span>Use my profile picture</span>
        {!hasPicture && (
          <small>Add a picture in your profile to use it here.</small>
        )}
      </label>
      <div className="avatar-grid">
        {AVATAR_IDS.map((id) => (
          <label key={id} className="avatar-option">
            <input
              type="radio"
              name="avatar-choice"
              aria-label={`${AVATAR_LABELS[id]} avatar`}
              checked={value.kind === "avatar" && value.id === id}
              onChange={() => onChange({ kind: "avatar", id })}
            />
            <Avatar avatar={{ kind: "avatar", id }} name={AVATAR_LABELS[id]} />
          </label>
        ))}
      </div>
    </fieldset>
  );
}
