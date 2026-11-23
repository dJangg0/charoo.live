// Group and room joins: enter with the profile, or as a guest with an optional nickname.
export function JoinIdentityChoice({
  mode,
  onModeChange,
  nickname,
  onNicknameChange,
  profileName,
}: {
  mode: "profile" | "guest";
  onModeChange: (mode: "profile" | "guest") => void;
  nickname: string;
  onNicknameChange: (nickname: string) => void;
  profileName: string;
}) {
  return (
    <fieldset className="join-identity">
      <legend>How should you join?</legend>
      <label className="join-identity-option">
        <input
          type="radio"
          name="join-identity"
          checked={mode === "profile"}
          onChange={() => onModeChange("profile")}
        />
        <span>
          Join with my profile <small>{profileName}</small>
        </span>
      </label>
      <label className="join-identity-option">
        <input
          type="radio"
          name="join-identity"
          checked={mode === "guest"}
          onChange={() => onModeChange("guest")}
        />
        <span>Join as a guest</span>
      </label>
      {mode === "guest" && (
        <label className="join-identity-nickname">
          Nickname (optional)
          <input
            type="text"
            name="guest-nickname"
            value={nickname}
            minLength={2}
            maxLength={24}
            placeholder="Leave empty for a random guest name"
            onChange={(event) => onNicknameChange(event.target.value)}
          />
          <small>
            Your account name and profile picture stay hidden in this room.
          </small>
        </label>
      )}
    </fieldset>
  );
}
