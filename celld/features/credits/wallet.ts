// Credit wallet domain (FR-13, BE-08). Pure D1 statement builders. Only
// AppCoordinator consumes these, inside its serialized commands and atomic
// batches; no route may mutate credits directly.
//
// Idempotency: credit_entries.entry_key is the sole replay guard. Every
// balance-changing statement is gated by NOT EXISTS on that key, so a replayed
// grant or spend changes nothing and the ledger insert is ON CONFLICT DO NOTHING.
//
// Overdraft: the batch cannot branch on a row count, so the debit is enforced by
// CHECK(balance>=0) on credit_wallets, which aborts the whole atomic batch.
// AppCoordinator also pre-checks the balance to return a clean error.
import type { Env } from "../../env";
import type { CreditEntryKind, Settings } from "@charoo/contracts";
import { all, first, iso, stmt } from "../../shared/data";
import { requireThat } from "../../shared/errors";

export type Wallet = {
  balance: number;
  lifetimeEarned: number;
  lifetimeSpent: number;
  extraContactSlots: number;
  lastDailyGrantOn: string | null;
  dailyStreak: number;
};

export const zeroWallet = (): Wallet => ({
  balance: 0,
  lifetimeEarned: 0,
  lifetimeSpent: 0,
  extraContactSlots: 0,
  lastDailyGrantOn: null,
  dailyStreak: 0,
});

export async function walletOf(env: Env, userId: string): Promise<Wallet> {
  const r = await first(env, "SELECT * FROM credit_wallets WHERE user_id=?", [
    userId,
  ]);
  if (!r) return zeroWallet();
  return {
    balance: Number(r.balance),
    lifetimeEarned: Number(r.lifetime_earned),
    lifetimeSpent: Number(r.lifetime_spent),
    extraContactSlots: Number(r.extra_contact_slots),
    lastDailyGrantOn: r.last_daily_grant_on ?? null,
    dailyStreak: Number(r.daily_streak),
  };
}

export async function entryExists(env: Env, entryKey: string) {
  return !!(await first(env, "SELECT 1 FROM credit_entries WHERE entry_key=?", [
    entryKey,
  ]));
}

export function ensureWalletStatement(env: Env, userId: string) {
  return stmt(
    env,
    "INSERT INTO credit_wallets(user_id,updated_at) VALUES(?,?) ON CONFLICT(user_id) DO NOTHING",
    [userId, iso()],
  );
}

function ledgerStatement(
  env: Env,
  userId: string,
  kind: CreditEntryKind,
  delta: number,
  entryKey: string,
  reference: string | null,
  at: string,
) {
  // balance_after reads the wallet row written by the preceding statement in
  // the same batch, so the ledger reconciles with credit_wallets.balance.
  return stmt(
    env,
    "INSERT INTO credit_entries(id,user_id,entry_key,kind,delta,balance_after,reference,created_at) VALUES(?,?,?,?,?,(SELECT balance FROM credit_wallets WHERE user_id=?),?,?) ON CONFLICT(entry_key) DO NOTHING",
    [crypto.randomUUID(), userId, entryKey, kind, delta, userId, reference, at],
  );
}

// Grant: wallet ensure, idempotent credit, ledger row. `prefix` statements (for
// example, a daily-streak update) run before the credit and share its gate.
export function grantStatements(
  env: Env,
  userId: string,
  kind: CreditEntryKind,
  amount: number,
  entryKey: string,
  reference: string | null,
  prefix: D1PreparedStatement[] = [],
): D1PreparedStatement[] {
  const at = iso();
  return [
    ensureWalletStatement(env, userId),
    ...prefix,
    stmt(
      env,
      "UPDATE credit_wallets SET balance=balance+?,lifetime_earned=lifetime_earned+?,updated_at=? WHERE user_id=? AND NOT EXISTS(SELECT 1 FROM credit_entries WHERE entry_key=?)",
      [amount, amount, at, userId, entryKey],
    ),
    ledgerStatement(env, userId, kind, amount, entryKey, reference, at),
  ];
}

// Spend: idempotent debit. `prefix` statements run before the debit and must
// be gated on the same entry key (for example, a purchased slot increment).
export function spendStatements(
  env: Env,
  userId: string,
  kind: CreditEntryKind,
  amount: number,
  entryKey: string,
  reference: string | null,
  prefix: D1PreparedStatement[] = [],
): D1PreparedStatement[] {
  const at = iso();
  return [
    ensureWalletStatement(env, userId),
    ...prefix,
    stmt(
      env,
      "UPDATE credit_wallets SET balance=balance-?,lifetime_spent=lifetime_spent+?,updated_at=? WHERE user_id=? AND NOT EXISTS(SELECT 1 FROM credit_entries WHERE entry_key=?)",
      [amount, amount, at, userId, entryKey],
    ),
    ledgerStatement(env, userId, kind, -amount, entryKey, reference, at),
  ];
}

// Purchased slot increment; runs before the debit and shares its entry key gate.
export function slotIncrementStatement(
  env: Env,
  userId: string,
  slots: number,
  entryKey: string,
) {
  return stmt(
    env,
    "UPDATE credit_wallets SET extra_contact_slots=extra_contact_slots+? WHERE user_id=? AND NOT EXISTS(SELECT 1 FROM credit_entries WHERE entry_key=?)",
    [slots, userId, entryKey],
  );
}

export async function contactUsage(env: Env, userId: string) {
  return Number(
    (
      await first(
        env,
        "SELECT count(*) AS n FROM contacts WHERE user_a=? OR user_b=?",
        [userId, userId],
      )
    )?.n ?? 0,
  );
}

// Contacts are capped only while credits are enabled. Limit = base + purchased slots.
export function contactLimit(
  cfg: Pick<Settings, "credits_contact_slot_base">,
  wallet: Pick<Wallet, "extraContactSlots">,
) {
  return cfg.credits_contact_slot_base + wallet.extraContactSlots;
}

// Activity rewards are capped per user per UTC day so repeated quick chats cannot mint unlimited credits.
export const ACTIVITY_REWARDS_PER_DAY = 5;

export async function activityGrantsToday(env: Env, userId: string) {
  return Number(
    (
      await first(
        env,
        "SELECT count(*) AS n FROM credit_entries WHERE user_id=? AND kind='GRANT_ACTIVITY' AND created_at>=?",
        [userId, `${utcDay()}T00:00:00.000Z`],
      )
    )?.n ?? 0,
  );
}

export function utcDay(at = Date.now()) {
  return iso(at).slice(0, 10);
}

// Pure streak math. A claim on the day after the last claim continues the streak;
// any longer gap restarts it at one. The bonus stops growing at max_days.
export function dailyClaim(
  wallet: Pick<Wallet, "lastDailyGrantOn" | "dailyStreak">,
  cfg: Pick<
    Settings,
    | "credits_daily_base"
    | "credits_daily_streak_bonus"
    | "credits_daily_streak_max_days"
  >,
  todayUtc: string,
) {
  if (wallet.lastDailyGrantOn === todayUtc)
    return {
      claimable: false,
      streak: wallet.dailyStreak,
      amount: 0,
    };
  const yesterday = utcDay(Date.parse(`${todayUtc}T00:00:00Z`) - 86400000);
  const streak =
    wallet.lastDailyGrantOn === yesterday ? wallet.dailyStreak + 1 : 1;
  const amount =
    cfg.credits_daily_base +
    Math.min(streak - 1, cfg.credits_daily_streak_max_days - 1) *
      cfg.credits_daily_streak_bonus;
  return { claimable: true, streak, amount };
}

// Reconnect is free while credits are disabled, which preserves pre-economy behavior.
export function reconnectPrice(
  cfg: Pick<Settings, "credits_enabled" | "reconnect_price">,
) {
  return cfg.credits_enabled ? cfg.reconnect_price : 0;
}

export function requireCredits(cfg: Pick<Settings, "credits_enabled">) {
  requireThat(cfg.credits_enabled, 403, "Credits are unavailable");
}

export async function ledgerPage(
  env: Env,
  userId: string,
  after: { at: string; id: string } | null,
) {
  const rows = await all(
    env,
    `SELECT id,kind,delta,balance_after,reference,created_at FROM credit_entries
     WHERE user_id=? AND (? IS NULL OR (created_at,id)<(?,?))
     ORDER BY created_at DESC,id DESC LIMIT 26`,
    [userId, after?.at ?? null, after?.at ?? null, after?.id ?? null],
  );
  const page = rows.slice(0, 25);
  return {
    entries: page.map((r) => ({
      id: r.id,
      kind: r.kind,
      delta: Number(r.delta),
      balanceAfter: Number(r.balance_after),
      reference: r.reference,
      createdAt: r.created_at,
    })),
    lastRow: page.at(-1) ?? null,
    hasMore: rows.length > 25,
  };
}
