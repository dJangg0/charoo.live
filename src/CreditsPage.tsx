import { Coins } from "lucide-react";

// Credits (FR-13). Every balance shown here comes from the authoritative
// GET /api/credits response. The client does no optimistic balance math.
export interface CreditSummary {
  enabled: boolean;
  balance: number;
  lifetimeEarned: number;
  lifetimeSpent: number;
  contactSlots: {
    used: number;
    limit: number;
    base: number;
    extra: number;
    max: number;
    pack: number;
    price: number;
  };
  daily: { claimable: boolean; streak: number; amount: number };
  peekPrice: number;
  reconnectPrice: number;
  packs: {
    id: string;
    credits: number;
    amountMinor: number;
    currency: string;
  }[];
}

export interface LedgerEntry {
  id: string;
  kind: string;
  delta: number;
  balanceAfter: number;
  reference: string | null;
  createdAt: string;
}

export interface LedgerState {
  entries: LedgerEntry[];
  next: string | null;
  state: "idle" | "loading" | "error";
  error?: string;
}

const KIND_LABELS: Record<string, string> = {
  GRANT_VERIFY: "Welcome bonus",
  GRANT_DAILY: "Daily credits",
  GRANT_ACTIVITY: "Chat milestone reward",
  TOPUP: "Top-up",
  SPEND_PEEK: "Peek at a partner",
  SPEND_SLOTS: "Extra contact slots",
  SPEND_RECONNECT: "Reconnect",
  ADMIN_ADJUST: "Adjustment",
};

const money = (minor: number, currency: string) =>
  new Intl.NumberFormat("en", { style: "currency", currency }).format(
    minor / 100,
  );

export function CreditsPage({
  verified,
  credits,
  loadState,
  loadError,
  ledger,
  busy,
  sandboxReference,
  onRetry,
  onClaim,
  onBuySlots,
  onBuyPack,
  onLoadMore,
  onConfirmSandbox,
  onCancelSandbox,
  onVerify,
}: {
  verified: boolean;
  credits: CreditSummary | null;
  loadState: "idle" | "loading" | "error";
  loadError?: string;
  ledger: LedgerState;
  busy: boolean;
  sandboxReference: string | null;
  onRetry: () => void;
  onClaim: () => void;
  onBuySlots: () => void;
  onBuyPack: (packId: string) => void;
  onLoadMore: () => void;
  onConfirmSandbox: (reference: string) => void;
  onCancelSandbox: () => void;
  onVerify: () => void;
}) {
  if (!verified)
    return (
      <section className="credits-page" aria-label="Credits">
        <h2>Credits</h2>
        <p>Verify your account to start earning credits.</p>
        <p className="muted">
          Verifying gives you a welcome bonus, a daily claim and rewards for
          quick-chat milestones.
        </p>
        <button className="button" onClick={onVerify}>
          Verify to start earning
        </button>
      </section>
    );

  if (!credits) {
    return (
      <section className="credits-page" aria-label="Credits">
        <h2>Credits</h2>
        {loadState === "error" ? (
          <>
            <p role="alert">{loadError || "Couldn’t load your credits."}</p>
            <button className="button secondary" onClick={onRetry}>
              Try again
            </button>
          </>
        ) : (
          <p role="status" aria-busy="true">
            Loading your credits…
          </p>
        )}
      </section>
    );
  }

  const slots = credits.contactSlots;
  const slotsFull = slots.limit + slots.pack > slots.max;
  const cannotAffordSlots = credits.balance < slots.price;

  return (
    <section className="credits-page" aria-label="Credits">
      <h2>Credits</h2>
      <div className="credits-balance" aria-label="Balance">
        <span className="credits-balance-amount">
          <Coins size={20} aria-hidden="true" /> {credits.balance}
        </span>
        <span className="muted">
          {credits.lifetimeEarned} earned · {credits.lifetimeSpent} spent
        </span>
      </div>

      <div className="credits-card">
        <h3>Daily credits</h3>
        {credits.daily.claimable ? (
          <>
            <p>
              Claim {credits.daily.amount} credits today
              {credits.daily.streak > 0
                ? ` · streak ${credits.daily.streak}`
                : ""}
              .
            </p>
            <button className="button" disabled={busy} onClick={onClaim}>
              {busy ? "Claiming…" : `Claim ${credits.daily.amount} credits`}
            </button>
          </>
        ) : (
          <p className="muted">
            You claimed today’s credits. Current streak: {credits.daily.streak}{" "}
            {credits.daily.streak === 1 ? "day" : "days"}. Come back tomorrow.
          </p>
        )}
      </div>

      <div className="credits-card">
        <h3>Saved contacts</h3>
        <p>
          {slots.used} of {slots.limit} saved
          {slots.used >= slots.limit ? " · storage full" : ""}. {slots.base} are
          free; purchased slots are permanent.
        </p>
        {slotsFull ? (
          <p className="muted">
            You have reached the maximum of {slots.max} contacts.
          </p>
        ) : (
          <button
            className="button secondary"
            disabled={busy || cannotAffordSlots}
            onClick={onBuySlots}
            title={cannotAffordSlots ? "Not enough credits" : undefined}
          >
            Buy {slots.pack} more slots for {slots.price} credits
          </button>
        )}
        {!slotsFull && cannotAffordSlots && (
          <p className="muted">
            You need {slots.price - credits.balance} more credits for this.
          </p>
        )}
      </div>

      <div className="credits-card">
        <h3>Top up</h3>
        {sandboxReference ? (
          <div
            className="credits-sandbox"
            role="dialog"
            aria-label="Test checkout"
          >
            <p>
              <strong>Test checkout.</strong> No real money moves in this
              environment.
            </p>
            <div className="credits-sandbox-actions">
              <button
                className="button"
                disabled={busy}
                onClick={() => onConfirmSandbox(sandboxReference)}
              >
                {busy ? "Confirming…" : "Confirm test payment"}
              </button>
              <button className="text-button" onClick={onCancelSandbox}>
                Cancel
              </button>
            </div>
          </div>
        ) : (
          <ul className="credits-packs">
            {credits.packs.map((pack) => (
              <li key={pack.id}>
                <span>
                  {pack.credits} credits ·{" "}
                  {money(pack.amountMinor, pack.currency)}
                </span>
                <button
                  className="button secondary small"
                  disabled={busy}
                  onClick={() => onBuyPack(pack.id)}
                >
                  Buy
                </button>
              </li>
            ))}
          </ul>
        )}
      </div>

      <div className="credits-card">
        <h3>Activity</h3>
        {ledger.state === "error" && (
          <p role="alert">{ledger.error || "Couldn’t load your activity."}</p>
        )}
        {ledger.entries.length === 0 && ledger.state !== "loading" && (
          <p className="muted">No credit activity yet.</p>
        )}
        {ledger.entries.length > 0 && (
          <ul className="credits-ledger" aria-label="Credit activity">
            {ledger.entries.map((entry) => (
              <li key={entry.id}>
                <span>
                  {KIND_LABELS[entry.kind] || "Credits"}
                  <small className="muted">
                    {" "}
                    {new Date(entry.createdAt).toLocaleString()}
                  </small>
                </span>
                <span
                  className={entry.delta < 0 ? "credit-debit" : "credit-credit"}
                >
                  {entry.delta > 0 ? "+" : ""}
                  {entry.delta}
                  <small className="muted"> · {entry.balanceAfter}</small>
                </span>
              </li>
            ))}
          </ul>
        )}
        {ledger.state === "loading" && (
          <p role="status" aria-busy="true">
            Loading activity…
          </p>
        )}
        {ledger.next && ledger.state !== "loading" && (
          <button className="button secondary small" onClick={onLoadMore}>
            Load more activity
          </button>
        )}
      </div>
    </section>
  );
}
