import { z } from "zod";
export const QUICK_CHAT_SEARCH_TIMEOUT_MS = 2 * 60 * 1000;
// Quick-chat milestones. Each participant's committed words unlock permitted
// ASL (default ten words each, admin-configurable). Each participant's
// distinct committed messages unlock the profile reveal (default ten messages
// each, admin-configurable). Thresholds live in settings; these are defaults.
export const QUICK_CHAT_ASL_WORDS = 10;
// Per-participant word counts stop at this cap.
export const QUICK_CHAT_WORD_CAP = 20;
// Per-participant distinct-message counts stop at this cap.
export const QUICK_CHAT_MESSAGE_CAP = 50;
export const roomTypes = [
  "AVAILABLE_TONIGHT",
  "SHARED_GROUP",
  "STRANGER",
  "PRIVATE",
  "CONTACT",
] as const;
export type RoomType = (typeof roomTypes)[number];
export const categories = [
  "Conversation",
  "Hangout",
  "Food & Drinks",
  "Gaming",
  "Events",
  "Music",
  "Study",
  "Sports",
  "Random",
  "Other",
] as const;
export const visibility = z.enum(["public", "contacts_only", "private"]);
export const profileSchema = z.object({
  displayName: z.string().trim().min(2).max(40),
  age: z.number().int().min(18).max(120).nullable(),
  gender: z.string().trim().max(40),
  region: z.string().trim().max(80),
  bio: z.string().trim().max(300),
  interests: z.array(z.string().trim().min(1).max(30)).max(10),
  aslVisibility: visibility,
});
const communityConsentSchema = z.union([
  z.object({ communityConsent: z.literal(true) }),
  // Keep existing clients working while the app switches to community consent.
  z.object({ adultConsent: z.literal(true) }),
]);
export const guestSchema = z
  .object({ profile: profileSchema.optional() })
  .and(communityConsentSchema);
export const emailSchema = z
  .object({
    email: z.string().email().max(254),
    roomToken: z
      .string()
      .regex(/^[A-Za-z0-9_-]{43}$/)
      .optional(),
  })
  .and(communityConsentSchema);
export const roomSchema = z.object({
  clientOperationId: z
    .string()
    .uuid()
    .transform((value) => value.toLowerCase())
    .optional(),
  type: z.enum(["AVAILABLE_TONIGHT", "SHARED_GROUP"]),
  title: z.string().trim().min(3).max(100),
  description: z.string().trim().max(500).default(""),
  category: z.enum(categories).default("Conversation"),
  region: z.string().trim().max(80).default(""),
  tags: z.array(z.string().trim().min(1).max(30)).max(10).default([]),
  verifiedOnly: z.boolean().default(false),
  noTimeLimit: z.boolean().default(false),
  durationHours: z.number().int().min(1).max(24).optional(),
});
export const messageSchema = z.object({
  clientMessageId: z
    .string()
    .uuid()
    .transform((value) => value.toLowerCase()),
  text: z.string().trim().min(1).max(4000),
  replyTo: z
    .string()
    .uuid()
    .transform((value) => value.toLowerCase())
    .nullable()
    .optional(),
  attachmentId: z
    .string()
    .uuid()
    .transform((value) => value.toLowerCase())
    .nullable()
    .optional(),
});
export const requestSchema = z.object({
  targetId: z
    .string()
    .uuid()
    .transform((value) => value.toLowerCase()),
  kind: z.enum(["PRIVATE", "CONTACT", "RECONNECT"]),
  roomId: z
    .string()
    .uuid()
    .transform((value) => value.toLowerCase())
    .optional(),
});
export const reportSchema = z
  .object({
    targetId: z
      .string()
      .uuid()
      .transform((value) => value.toLowerCase())
      .optional(),
    roomId: z
      .string()
      .uuid()
      .transform((value) => value.toLowerCase())
      .optional(),
    messageId: z
      .string()
      .uuid()
      .transform((value) => value.toLowerCase())
      .optional(),
    reason: z.string().trim().min(5).max(1000),
  })
  .refine(
    (v) => !!(v.targetId || v.roomId || v.messageId),
    "A report needs a target",
  );
export type Profile = z.infer<typeof profileSchema>;
export interface User {
  id: string;
  displayName: string;
  verified: boolean;
  role: "USER" | "SUPPORT" | "MODERATOR" | "ADMIN";
  profile: Profile;
  status: string;
}
export interface Room {
  id: string;
  type: RoomType;
  title: string;
  description: string;
  category: string;
  region: string;
  tags: string[];
  creator_id: string;
  expires_at: string | null;
  state: string;
  online: number;
  verified_only: boolean;
  slow_mode: number;
  shareUrl?: string | null;
}
export interface Message {
  id: string;
  roomId: string;
  senderId: string;
  name: string;
  text: string;
  createdAt: string;
  clientMessageId: string;
  replyTo: string | null;
  replyPreview?: {
    id: string;
    senderId: string;
    name: string;
    text: string;
  } | null;
  attachmentId: string | null;
  reactions: Record<string, string[]>;
  readBy?: string[];
}
export interface Event {
  type: string;
  roomId?: string;
  userIds?: string[];
  payload?: unknown;
}
export const defaultSettings = {
  guest_access_enabled: true,
  available_tonight_enabled: true,
  available_tonight_duration_hours: 6,
  available_room_retention_hours: 12,
  shared_room_retention_hours: 24,
  conversation_retention_hours: 24,
  available_room_creation_limit: 3,
  asl_reveal_threshold: 10,
  minimum_messages_per_user: 5,
  asl_minimum_duration_seconds: 120,
  available_room_slow_mode: 2,
  upload_size_limit_mb: 10,
  available_room_media_enabled: false,
  video_enabled: false,
  AI_assistant_enabled: false,
  quickchat_rematch_cooldown_minutes: 5,
  quickchat_asl_word_threshold: QUICK_CHAT_ASL_WORDS,
  quickchat_picture_message_threshold: 10,
  reconnect_price: 3,
  credits_enabled: false,
  credits_verify_bonus: 50,
  credits_daily_base: 5,
  credits_daily_streak_bonus: 2,
  credits_daily_streak_max_days: 7,
  credits_activity_milestone_reward: 3,
  credits_peek_price: 10,
  credits_contact_slot_base: 10,
  credits_contact_slot_pack: 5,
  credits_contact_slot_price: 15,
  credits_contact_slot_max: 50,
};
export const settingsSchema = z.object({
  guest_access_enabled: z.boolean(),
  available_tonight_enabled: z.boolean(),
  available_tonight_duration_hours: z.number().int().min(1).max(24),
  available_room_retention_hours: z.number().int().min(1).max(24),
  shared_room_retention_hours: z.number().int().min(1).max(168),
  conversation_retention_hours: z.number().int().min(1).max(168),
  available_room_creation_limit: z.number().int().min(1).max(20),
  asl_reveal_threshold: z.number().int().min(2).max(200),
  minimum_messages_per_user: z.number().int().min(1).max(100),
  asl_minimum_duration_seconds: z.number().int().min(30).max(3600),
  available_room_slow_mode: z.number().int().min(0).max(60),
  upload_size_limit_mb: z.number().int().min(1).max(25),
  available_room_media_enabled: z.boolean(),
  video_enabled: z.boolean(),
  AI_assistant_enabled: z.boolean(),
  quickchat_rematch_cooldown_minutes: z.number().int().min(0).max(1440),
  quickchat_asl_word_threshold: z
    .number()
    .int()
    .min(2)
    .max(QUICK_CHAT_WORD_CAP),
  quickchat_picture_message_threshold: z
    .number()
    .int()
    .min(1)
    .max(QUICK_CHAT_MESSAGE_CAP),
  reconnect_price: z.number().int().min(0).max(100),
  credits_enabled: z.boolean(),
  credits_verify_bonus: z.number().int().min(0).max(100000),
  credits_daily_base: z.number().int().min(0).max(10000),
  credits_daily_streak_bonus: z.number().int().min(0).max(10000),
  credits_daily_streak_max_days: z.number().int().min(1).max(365),
  credits_activity_milestone_reward: z.number().int().min(0).max(10000),
  credits_peek_price: z.number().int().min(0).max(10000),
  credits_contact_slot_base: z.number().int().min(0).max(1000),
  credits_contact_slot_pack: z.number().int().min(1).max(100),
  credits_contact_slot_price: z.number().int().min(0).max(100000),
  credits_contact_slot_max: z.number().int().min(1).max(1000),
});
export type Settings = typeof defaultSettings;
export { z };

// Group rooms let each member show their profile picture or one of these generated avatars.
export const AVATAR_IDS = [
  "sky",
  "sun",
  "mint",
  "rose",
  "violet",
  "ember",
  "slate",
  "moss",
] as const;
export type AvatarId = (typeof AVATAR_IDS)[number];
export const avatarChoiceSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("picture") }),
  z.object({ kind: z.literal("avatar"), id: z.enum(AVATAR_IDS) }),
]);
export type AvatarChoice = z.infer<typeof avatarChoiceSchema>;

// Credits economy (FR-13). Pack prices are contract data, not admin settings:
// currency and gateway configuration are not a generic number input.
// Provisional placeholder prices until a real gateway and pricing are agreed.
export const CREDIT_PACKS = [
  { id: "pack-100", credits: 100, amountMinor: 500, currency: "USD" },
  { id: "pack-300", credits: 300, amountMinor: 1200, currency: "USD" },
  { id: "pack-1000", credits: 1000, amountMinor: 3500, currency: "USD" },
] as const;
export type CreditPack = (typeof CREDIT_PACKS)[number];
export const creditPackIds = CREDIT_PACKS.map((pack) => pack.id) as [
  CreditPack["id"],
  ...CreditPack["id"][],
];
export const CREDIT_ENTRY_KINDS = [
  "GRANT_VERIFY",
  "GRANT_DAILY",
  "GRANT_ACTIVITY",
  "TOPUP",
  "SPEND_PEEK",
  "SPEND_SLOTS",
  "SPEND_RECONNECT",
  "ADMIN_ADJUST",
] as const;
export type CreditEntryKind = (typeof CREDIT_ENTRY_KINDS)[number];
export const creditOrderSchema = z.object({
  packId: z.enum(creditPackIds),
});
// The client confirms exactly what the pre-flight showed; the server refuses
// the charge if the reveal changed since then.
export const peekSchema = z.object({
  revealsAsl: z.boolean(),
  revealsPicture: z.boolean(),
});
export const slotPurchaseSchema = z.object({
  clientOperationId: z
    .string()
    .uuid()
    .transform((value) => value.toLowerCase()),
});
