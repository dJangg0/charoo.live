import {
  pictureCommand,
  pictureScanAccess,
  cleanupPictures,
} from "../features/profile-pictures/state";
import { DurableObject } from "cloudflare:workers";
import type { Env } from "../env";
import {
  guestSchema,
  emailSchema,
  profileSchema,
  roomSchema,
  requestSchema,
  settingsSchema,
  creditOrderSchema,
  peekSchema,
  slotPurchaseSchema,
  CREDIT_PACKS,
} from "@charoo/contracts";
import {
  all,
  first,
  run,
  stmt,
  iso,
  user,
  authenticate,
  account,
  emptyProfile,
  settings,
  blocked,
  roomStub,
  publicUser,
  audit,
  auditStatement,
  type Actor,
  type RoomRecord,
} from "../shared/data";
import { token, hash, encrypt, decrypt } from "../shared/crypto";
import { requireThat, result, unwrap, type Result } from "../shared/errors";
import { ensureSchema } from "../shared/migrations";
import type { GoogleIdentity } from "../features/auth/google";
import {
  walletOf,
  entryExists,
  grantStatements,
  spendStatements,
  slotIncrementStatement,
  contactUsage,
  contactLimit,
  dailyClaim,
  reconnectPrice,
  requireCredits,
  utcDay,
  activityGrantsToday,
  ACTIVITY_REWARDS_PER_DAY,
} from "../features/credits/wallet";

export class AppCoordinator extends DurableObject<Env> {
  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    ctx.blockConcurrencyWhile(() => ensureSchema(env));
  }
  async ready() {
    return true;
  }
  async command(
    actor: Actor | null,
    kind: string,
    input: any,
  ): Promise<Result<any>> {
    return this.ctx.blockConcurrencyWhile(() =>
      result(async () => {
        const env = this.env;
        const u =
          actor && kind !== "verify" ? await authenticate(env, actor) : null;
        if (kind.startsWith("picture.")) {
          requireThat(u && actor, 401, "Sign in to continue");
          try {
            return await pictureCommand(env, actor, kind, input);
          } finally {
            if (!["picture.current", "picture.download"].includes(kind))
              await this.ctx.storage.setAlarm(Date.now() + 1000);
          }
        }
        switch (kind) {
          case "guest": {
            const b = guestSchema.parse(input);
            requireThat(
              (await settings(env)).guest_access_enabled,
              403,
              "Guest access is disabled",
            );
            if (u)
              return {
                user: publicUser(u),
                csrf: (await first(
                  env,
                  "SELECT csrf FROM sessions WHERE token_hash=?",
                  [actor!.sessionHash],
                ))!.csrf,
              };
            const id = crypto.randomUUID(),
              name = b.profile?.displayName || `Guest ${token().slice(0, 4)}`;
            await run(
              env,
              "INSERT INTO users(id,display_name,profile,created_at,guest_expires_at) VALUES(?,?,?,?,?)",
              [
                id,
                name,
                JSON.stringify(b.profile || emptyProfile(name)),
                iso(),
                iso(Date.now() + 604800000),
              ],
            );
            return this.issue(id);
          }
          case "email": {
            const b = emailSchema.parse(input);
            const id = u?.id || crypto.randomUUID();
            if (!u)
              await run(
                env,
                "INSERT INTO users(id,display_name,profile,created_at,guest_expires_at) VALUES(?,?,?,?,?)",
                [
                  id,
                  "New friend",
                  JSON.stringify(emptyProfile("New friend")),
                  iso(),
                  iso(Date.now() + 604800000),
                ],
              );
            const t = token();
            await run(
              env,
              "INSERT INTO email_tokens(token_hash,email,user_id,expires_at,room_token) VALUES(?,?,?,?,?)",
              [
                await hash(t),
                b.email.toLowerCase(),
                id,
                iso(Date.now() + 900000),
                b.roomToken || null,
              ],
            );
            return {
              email: b.email.toLowerCase(),
              token: t,
              roomToken: b.roomToken,
            };
          }
          case "verify": {
            const th = await hash(input.token);
            const v = await first(
              env,
              "SELECT * FROM email_tokens WHERE token_hash=? AND expires_at>?",
              [th, iso()],
            );
            requireThat(v, 400, "This link is invalid or expired");
            const existing = await first(
              env,
              "SELECT * FROM users WHERE email=?",
              [v.email],
            );
            // A valid one-use email credential may upgrade an expired guest.
            // Bans and suspensions still apply before issuing a new session.
            const current = await user(env, v.user_id, {
              allowExpiredGuest: true,
            });
            if (!existing && current.verified)
              requireThat(
                current.email === v.email,
                409,
                "Sign out before verifying a different email",
              );
            const id = existing?.id || v.user_id;
            const signedInAccount = await user(env, id, {
              allowExpiredGuest: !existing,
            });
            const t = token(),
              csrf = token(),
              sh = await hash(t);
            const writes = [
              stmt(env, "DELETE FROM email_tokens WHERE token_hash=?", [th]),
            ];
            if (!existing && !current.verified)
              writes.push(
                stmt(
                  env,
                  "UPDATE users SET email=?,verified=1,guest_expires_at=NULL WHERE id=?",
                  [v.email, id],
                ),
                stmt(env, "DELETE FROM sessions WHERE user_id=?", [id]),
                ...(await this.verifyBonus(id)),
              );
            if (actor)
              writes.push(
                stmt(env, "DELETE FROM sessions WHERE token_hash=?", [
                  actor.sessionHash,
                ]),
              );
            writes.push(
              stmt(
                env,
                "INSERT INTO sessions(token_hash,user_id,csrf,expires_at) VALUES(?,?,?,?)",
                [sh, id, csrf, iso(Date.now() + 604800000)],
              ),
            );
            if (signedInAccount.role !== "USER")
              writes.push(
                auditStatement(env, id, "staff.sign_in", id, {
                  method: "email",
                  role: signedInAccount.role,
                }),
              );
            await env.DB.batch(writes);
            return { user: publicUser(await user(env, id)), csrf, token: t };
          }
          case "oauth.start": {
            if (input.oldBrowserHash)
              await run(env, "DELETE FROM oauth_flows WHERE browser_hash=?", [
                input.oldBrowserHash,
              ]);
            await run(
              env,
              "INSERT INTO oauth_flows(state_hash,browser_hash,nonce,code_verifier,session_hash,user_id,room_token,create_room,expires_at) VALUES(?,?,?,?,?,?,?,?,?)",
              [
                input.stateHash,
                input.browserHash,
                input.nonce,
                input.codeVerifier,
                actor?.sessionHash || null,
                u?.id || null,
                input.roomToken || null,
                input.createRoom ? 1 : 0,
                iso(Date.now() + 600000),
              ],
            );
            return null;
          }
          case "oauth.consume": {
            const flow = await first(
              env,
              "DELETE FROM oauth_flows WHERE state_hash=? AND browser_hash=? AND expires_at>? RETURNING *",
              [input.stateHash, input.browserHash, iso()],
            );
            requireThat(flow, 400, "Google sign-in expired");
            return flow;
          }
          case "oauth.finish": {
            const identity = input.identity as GoogleIdentity;
            requireThat(
              (actor?.sessionHash || null) === input.sessionHash,
              409,
              "session_changed",
            );
            const linked = await first(
              env,
              "SELECT user_id FROM oauth_identities WHERE provider='google' AND subject=?",
              [identity.subject],
            );
            let id: string;
            if (linked) {
              requireThat(
                !u?.verified || u.id === linked.user_id,
                409,
                "account_conflict",
              );
              id = linked.user_id;
              await user(env, id);
            } else {
              requireThat(
                !u?.verified || u.email === identity.email,
                409,
                "account_conflict",
              );
              requireThat(
                identity.emailAuthoritative ||
                  (u?.verified && u.email === identity.email),
                403,
                "email_required",
              );
              const existing = await first(
                env,
                "SELECT * FROM users WHERE email=?",
                [identity.email],
              );
              id = existing?.id || u?.id || crypto.randomUUID();
              requireThat(
                !(await first(
                  env,
                  "SELECT 1 FROM oauth_identities WHERE provider='google' AND user_id=?",
                  [id],
                )),
                409,
                "account_conflict",
              );
              if (existing) await user(env, id);
              const writes = [];
              if (!existing && u)
                writes.push(
                  stmt(
                    env,
                    "UPDATE users SET email=?,verified=1,guest_expires_at=NULL WHERE id=?",
                    [identity.email, id],
                  ),
                  stmt(env, "DELETE FROM sessions WHERE user_id=?", [id]),
                  ...(await this.verifyBonus(id)),
                );
              else if (!existing)
                writes.push(
                  stmt(
                    env,
                    "INSERT INTO users(id,email,verified,display_name,profile,created_at) VALUES(?,?,1,?,?,?)",
                    [
                      id,
                      identity.email,
                      identity.name,
                      JSON.stringify(emptyProfile(identity.name)),
                      iso(),
                    ],
                  ),
                  ...(await this.verifyBonus(id)),
                );
              writes.push(
                stmt(
                  env,
                  "INSERT INTO oauth_identities(provider,subject,user_id) VALUES('google',?,?)",
                  [identity.subject, id],
                ),
              );
              await env.DB.batch(writes);
            }
            return this.issue(id, "google", actor?.sessionHash);
          }
          case "logout": {
            requireThat(u, 401, "Sign in to continue");
            await this.effect(
              "user.revoke",
              { userId: u.id, sessionHash: actor!.sessionHash },
              [
                stmt(env, "DELETE FROM sessions WHERE token_hash=?", [
                  actor!.sessionHash,
                ]),
                ...(u.role !== "USER"
                  ? [
                      auditStatement(env, u.id, "staff.sign_out", u.id, {
                        role: u.role,
                      }),
                    ]
                  : []),
              ],
            );
            return null;
          }
          case "profile": {
            requireThat(u, 401, "Sign in to continue");
            const p = profileSchema.parse(input);
            await run(
              env,
              "UPDATE users SET display_name=?,profile=? WHERE id=?",
              [p.displayName, JSON.stringify(p), u.id],
            );
            return publicUser(await user(env, u.id));
          }
          case "room.create": {
            requireThat(u, 401, "Sign in to continue");
            const b = roomSchema.parse(input);
            const cfg = await settings(env);
            const operationId = b.clientOperationId
              ? `create:${u.id}:${b.clientOperationId}`
              : undefined;
            const previous = operationId
              ? await first(env, "SELECT payload FROM operations WHERE id=?", [
                  operationId,
                ])
              : null;
            if (previous) {
              const saved = JSON.parse(previous.payload);
              requireThat(!saved.purged, 410, "This conversation has ended");
              await this.deliverInternal(operationId!);
              unwrap(await roomStub(env, saved.record.id).authorize(actor!));
              return {
                id: saved.record.id,
                shareUrl: saved.invite
                  ? `${env.WEB_ORIGIN}/#room=${await decrypt(saved.invite.ciphertext, env.MESSAGE_KEY, `room-invite:${saved.record.id}`)}`
                  : null,
              };
            }

            if (b.type === "AVAILABLE_TONIGHT") {
              requireThat(
                u.verified,
                403,
                "Verify your email to use Available Tonight",
              );
              const count = await first(
                env,
                "SELECT count(*) AS n FROM room_index WHERE creator_id=? AND type='AVAILABLE_TONIGHT' AND state='OPEN' AND (expires_at IS NULL OR expires_at>?)",
                [u.id, iso()],
              );
              const pending = await first(
                env,
                "SELECT count(*) AS n FROM operations WHERE state='PENDING' AND json_extract(payload,'$.record.creator_id')=? AND json_extract(payload,'$.record.type')='AVAILABLE_TONIGHT'",
                [u.id],
              );
              requireThat(
                count!.n + pending!.n < cfg.available_room_creation_limit,
                429,
                "Close an active room before creating another",
              );
            } else
              requireThat(
                u.verified || cfg.guest_access_enabled,
                403,
                "Guest rooms disabled",
              );
            const id = crypto.randomUUID(),
              link = b.type === "SHARED_GROUP" ? token() : null;
            const expiresAt = b.noTimeLimit
              ? null
              : iso(
                  Date.now() +
                    Math.min(
                      b.durationHours || 24,
                      b.type === "AVAILABLE_TONIGHT"
                        ? cfg.available_room_retention_hours
                        : cfg.shared_room_retention_hours,
                    ) *
                      3600000,
                );
            const record = this.roomRecord(id, b.type, u.id, {
              title: b.title,
              description: b.description,
              category: b.category,
              region: b.region,
              tags: b.tags,
              verified_only: b.type === "AVAILABLE_TONIGHT" || b.verifiedOnly,
              slow_mode: cfg.available_room_slow_mode,
              expires_at: expiresAt,
            });
            const invite = link
              ? {
                  hash: await hash(link),
                  ciphertext: await encrypt(
                    link,
                    env.MESSAGE_KEY,
                    `room-invite:${id}`,
                  ),
                }
              : null;
            await this.create(record, [u.id], invite, operationId);
            return {
              id,
              shareUrl: link ? `${env.WEB_ORIGIN}/#room=${link}` : null,
            };
          }
          case "social.create": {
            requireThat(u?.verified, 403, "Verify your email first");
            const b = requestSchema.parse(input);
            const cfg = await settings(env);
            const target = await user(env, b.targetId);
            let requestExpiresAt = iso(Date.now() + 86400000);
            requireThat(
              target.verified && target.id !== u.id,
              400,
              "Choose another verified user",
            );
            requireThat(
              !(await blocked(env, u.id, target.id)),
              403,
              "Request unavailable",
            );
            if (b.kind === "RECONNECT") {
              requireThat(b.roomId, 400, "A past quick chat is required");
              const archive = await first(
                env,
                "SELECT expires_at FROM quick_chat_archives WHERE user_id=? AND peer_id=? AND room_id=? AND expires_at>?",
                [u.id, target.id, b.roomId, iso()],
              );
              requireThat(archive, 404, "Reconnect window expired");
              requestExpiresAt = archive.expires_at;
              const price = reconnectPrice(cfg);
              if (price > 0)
                requireThat(
                  (await walletOf(env, u.id)).balance >= price,
                  403,
                  "Not enough credits to reconnect",
                );
            } else {
              requireThat(b.roomId, 400, "A shared conversation is required");
              unwrap(await roomStub(env, b.roomId).authorize(actor!, false));
              // Contacts and private chats carry account names, so a guest entry on either side cannot use them.
              for (const id of [u.id, target.id])
                unwrap(await roomStub(env, b.roomId).hasParticipant(id, true));
              if (b.kind === "CONTACT") {
                // A quick chat can add a contact only after both profiles were shown.
                const room = unwrap(
                  await roomStub(env, b.roomId).disclosureState(actor!),
                );
                requireThat(
                  room.type !== "STRANGER" || room.profileEligible,
                  409,
                  "You can add this contact once you both reach the profile milestone",
                );
                if (cfg.credits_enabled)
                  requireThat(
                    (await contactUsage(env, u.id)) <
                      contactLimit(cfg, await walletOf(env, u.id)),
                    409,
                    "Contact storage full. Free a slot or buy more.",
                  );
              }
            }
            await run(
              env,
              "UPDATE social_requests SET state='REJECTED' WHERE state='PENDING' AND expires_at<=?",
              [iso()],
            );
            const previous = await first(
              env,
              "SELECT id,source_room_id FROM social_requests WHERE requester_id=? AND target_id=? AND kind=? AND state='PENDING'",
              [u.id, target.id, b.kind],
            );
            if (b.kind === "RECONNECT")
              requireThat(
                !previous || previous.source_room_id === b.roomId,
                409,
                "A reconnect request is already pending for this user",
              );
            if (b.kind === "RECONNECT" && previous) return { id: previous.id };
            const id = previous?.id || crypto.randomUUID();
            await this.effect(
              "event",
              {
                type: "request",
                userIds: [target.id],
                payload: {
                  kind: b.kind,
                  requesterId: u.id,
                  requesterName: u.display_name,
                },
              },
              previous
                ? []
                : [
                    stmt(
                      env,
                      "INSERT INTO social_requests(id,requester_id,target_id,kind,source_room_id,created_at,expires_at) VALUES(?,?,?,?,?,?,?)",
                      [
                        id,
                        u.id,
                        target.id,
                        b.kind,
                        b.roomId || null,
                        iso(),
                        requestExpiresAt,
                      ],
                    ),
                  ],
            );
            return { id };
          }
          case "social.respond": {
            requireThat(u?.verified, 403, "Verify your email first");
            const r = await first(
              env,
              "SELECT * FROM social_requests WHERE id=? AND target_id=?",
              [input.id, u.id],
            );
            requireThat(r && r.expires_at > iso(), 404, "Request unavailable");
            requireThat(
              r.state === "PENDING" || r.state === "ACCEPTED",
              404,
              "Request unavailable",
            );
            const requester = await user(env, r.requester_id);
            requireThat(
              !(await blocked(env, u.id, r.requester_id)),
              403,
              "Request unavailable",
            );
            if (r.state === "ACCEPTED")
              return { roomId: r.result_room_id, requesterId: r.requester_id };
            if (
              input.accept &&
              r.kind === "RECONNECT" &&
              !(await first(
                env,
                "SELECT 1 FROM quick_chat_archives WHERE user_id=? AND peer_id=? AND room_id=? AND expires_at>?",
                [r.requester_id, u.id, r.source_room_id, iso()],
              ))
            )
              requireThat(false, 404, "Reconnect window expired");
            let roomId: string | null = null;
            if (input.accept) {
              const cfg = await settings(env);
              const [a, b] = [u.id, r.requester_id].sort();
              const contact =
                r.kind === "CONTACT"
                  ? await first(
                      env,
                      "SELECT room_id FROM contacts WHERE user_a=? AND user_b=?",
                      [a, b],
                    )
                  : null;
              const op = await first(
                env,
                "SELECT payload FROM operations WHERE id=?",
                [`request:${r.id}`],
              );
              roomId =
                contact?.room_id ||
                (op ? JSON.parse(op.payload).record.id : crypto.randomUUID());
              // A new contact needs a free slot on both sides while credits are enabled.
              if (r.kind === "CONTACT" && !contact && cfg.credits_enabled) {
                requireThat(
                  (await contactUsage(env, u.id)) <
                    contactLimit(cfg, await walletOf(env, u.id)),
                  409,
                  "Your contact storage is full. Free a slot or buy more to accept.",
                );
                requireThat(
                  (await contactUsage(env, r.requester_id)) <
                    contactLimit(cfg, await walletOf(env, r.requester_id)),
                  409,
                  `${requester.display_name}’s contact storage is full.`,
                );
              }
              // The reconnect charge lands on acceptance. It is written in the same
              // atomic batch that creates the room, so failure leaves no partial state.
              const price =
                r.kind === "RECONNECT" && !op ? reconnectPrice(cfg) : 0;
              let charge: D1PreparedStatement[] = [];
              if (price > 0) {
                if ((await walletOf(env, r.requester_id)).balance < price) {
                  await this.effect(
                    "event",
                    {
                      type: "request.responded",
                      userIds: [u.id, r.requester_id],
                      payload: {
                        roomId: null,
                        requesterId: r.requester_id,
                        accepted: false,
                        expired: true,
                      },
                    },
                    [
                      stmt(
                        env,
                        "UPDATE social_requests SET state='EXPIRED' WHERE id=? AND state='PENDING'",
                        [r.id],
                      ),
                    ],
                  );
                  requireThat(
                    false,
                    409,
                    `${requester.display_name} no longer has enough credits to reconnect`,
                  );
                }
                charge = [
                  stmt(
                    env,
                    "UPDATE social_requests SET state='ACCEPTED',result_room_id=? WHERE id=? AND state='PENDING'",
                    [roomId, r.id],
                  ),
                  ...spendStatements(
                    env,
                    r.requester_id,
                    "SPEND_RECONNECT",
                    price,
                    `reconnect:${r.id}`,
                    r.id,
                  ),
                ];
              }
              if (!contact)
                await this.create(
                  this.roomRecord(
                    roomId!,
                    r.kind === "CONTACT" ? "CONTACT" : "PRIVATE",
                    r.requester_id,
                    { slow_mode: 1 },
                  ),
                  [u.id, r.requester_id],
                  null,
                  `request:${r.id}`,
                  {
                    requestId: r.id,
                    a,
                    b,
                    contact: r.kind === "CONTACT",
                    requesterId: r.requester_id,
                  },
                  charge,
                );
              const writes = [
                stmt(
                  env,
                  "UPDATE social_requests SET state='ACCEPTED',result_room_id=? WHERE id=? AND state='PENDING'",
                  [roomId, r.id],
                ),
              ];
              if (r.kind === "CONTACT")
                writes.push(
                  stmt(
                    env,
                    "INSERT INTO contacts(user_a,user_b,room_id) VALUES(?,?,?) ON CONFLICT DO NOTHING",
                    [a, b, roomId],
                  ),
                );
              await env.DB.batch(writes);
            } else if (r.kind === "RECONNECT") {
              await env.DB.batch([
                stmt(
                  env,
                  "UPDATE social_requests SET state='REJECTED' WHERE id=? AND state='PENDING'",
                  [r.id],
                ),
                stmt(
                  env,
                  "DELETE FROM quick_chat_archives WHERE user_id=? AND peer_id=? AND room_id=?",
                  [r.requester_id, u.id, r.source_room_id],
                ),
              ]);
            } else
              await run(
                env,
                "UPDATE social_requests SET state='REJECTED' WHERE id=?",
                [r.id],
              );
            const outcome = {
              roomId,
              requesterId: r.requester_id,
              accepted: !!input.accept,
            };
            await this.enqueue("event", {
              type: "request.responded",
              userIds: [u.id, r.requester_id],
              payload: outcome,
            });
            return outcome;
          }
          case "contact.remove": {
            requireThat(u, 401, "Sign in to continue");
            const [a, b] = [u.id, input.targetId].sort();
            const c = await first(
              env,
              "SELECT room_id FROM contacts WHERE user_a=? AND user_b=?",
              [a, b],
            );
            if (c)
              await this.effect(
                "room.close",
                { roomId: c.room_id, actorId: u.id },
                [
                  stmt(
                    env,
                    "DELETE FROM contacts WHERE user_a=? AND user_b=?",
                    [a, b],
                  ),
                ],
              );
            return null;
          }
          case "block": {
            requireThat(u, 401, "Sign in to continue");
            requireThat(u.id !== input.targetId, 400, "Cannot block yourself");
            await user(env, input.targetId);
            const revokeId = crypto.randomUUID(),
              eventId = crypto.randomUUID();
            await env.DB.batch([
              stmt(
                env,
                "INSERT INTO blocks(user_id,target_id) VALUES(?,?) ON CONFLICT DO NOTHING",
                [u.id, input.targetId],
              ),
              stmt(
                env,
                "UPDATE social_requests SET state='REJECTED' WHERE state='PENDING' AND ((requester_id=? AND target_id=?) OR (requester_id=? AND target_id=?))",
                [u.id, input.targetId, input.targetId, u.id],
              ),
              this.effectStatement(revokeId, "pair.revoke", {
                a: u.id,
                b: input.targetId,
              }),
              this.effectStatement(eventId, "event", {
                type: "blocked",
                userIds: [u.id, input.targetId],
              }),
            ]);
            await this.ctx.storage.setAlarm(Date.now() + 1000);
            await this.deliverInternal(revokeId);
            await this.deliverInternal(eventId);
            return null;
          }
          case "unblock": {
            requireThat(u, 401, "Sign in to continue");
            await this.effect(
              "event",
              { type: "unblocked", userIds: [u.id, input.targetId] },
              [
                stmt(
                  env,
                  "DELETE FROM blocks WHERE user_id=? AND target_id=?",
                  [u.id, input.targetId],
                ),
              ],
            );
            return null;
          }
          case "settings": {
            requireThat(u?.role === "ADMIN", 403, "Admin role required");
            const b = settingsSchema.parse(input);
            const previous = await settings(env);
            const changes = Object.fromEntries(
              Object.entries(b)
                .filter(
                  ([key, value]) =>
                    previous[key as keyof typeof previous] !== value,
                )
                .map(([key, value]) => [
                  key,
                  {
                    before: previous[key as keyof typeof previous],
                    after: value,
                  },
                ]),
            );
            await env.DB.batch([
              stmt(env, "UPDATE settings SET value=? WHERE id=1", [
                JSON.stringify(b),
              ]),
              auditStatement(env, u.id, "settings.update", "settings", {
                changes,
              }),
            ]);
            return b;
          }
          case "admin.action": {
            requireThat(
              u && ["ADMIN", "MODERATOR"].includes(u.role),
              403,
              "Moderator role required",
            );
            if (input.action === "CLOSE_ROOM")
              await this.enqueue("room.close", {
                roomId: input.targetId,
                actorId: u.id,
              });
            else if (input.action === "RESOLVE_REPORT")
              await run(env, "UPDATE reports SET state='RESOLVED' WHERE id=?", [
                input.targetId,
              ]);
            else {
              requireThat(
                input.targetId !== u.id,
                400,
                "Cannot act on yourself",
              );
              const target = await first(
                env,
                "SELECT role FROM users WHERE id=?",
                [input.targetId],
              );
              requireThat(
                target?.role === "USER",
                403,
                "Staff accounts require an operator",
              );
              await this.effect("user.revoke", { userId: input.targetId }, [
                stmt(
                  env,
                  input.action === "BAN"
                    ? "UPDATE users SET banned=1 WHERE id=?"
                    : "UPDATE users SET suspended_until=? WHERE id=?",
                  input.action === "BAN"
                    ? [input.targetId]
                    : [iso(Date.now() + 86400000), input.targetId],
                ),
                stmt(env, "DELETE FROM sessions WHERE user_id=?", [
                  input.targetId,
                ]),
                stmt(
                  env,
                  "INSERT INTO audit_logs(id,actor_id,action,target_id,details,created_at) VALUES(?,?,?,?,?,?)",
                  [
                    crypto.randomUUID(),
                    u.id,
                    input.action.toLowerCase(),
                    input.targetId,
                    "{}",
                    iso(),
                  ],
                ),
              ]);
            }
            if (["CLOSE_ROOM", "RESOLVE_REPORT"].includes(input.action))
              await audit(
                env,
                u.id,
                input.action.toLowerCase(),
                input.targetId,
              );
            return null;
          }
          case "credits.claim_daily": {
            requireThat(u?.verified, 403, "Verify your email to earn credits");
            const cfg = await settings(env);
            requireCredits(cfg);
            const today = utcDay(),
              key = `daily:${u.id}:${today}`,
              wallet = await walletOf(env, u.id),
              claim = dailyClaim(wallet, cfg, today);
            if (!claim.claimable || (await entryExists(env, key)))
              return {
                claimed: false,
                amount: 0,
                streak: wallet.dailyStreak,
                balance: wallet.balance,
              };
            await env.DB.batch(
              grantStatements(
                env,
                u.id,
                "GRANT_DAILY",
                claim.amount,
                key,
                today,
                [
                  stmt(
                    env,
                    "UPDATE credit_wallets SET last_daily_grant_on=?,daily_streak=?,updated_at=? WHERE user_id=? AND NOT EXISTS(SELECT 1 FROM credit_entries WHERE entry_key=?)",
                    [today, claim.streak, iso(), u.id, key],
                  ),
                ],
              ),
            );
            return {
              claimed: true,
              amount: claim.amount,
              streak: claim.streak,
              balance: (await walletOf(env, u.id)).balance,
            };
          }
          case "credits.peek": {
            requireThat(u?.verified, 403, "Verify your email to use credits");
            const cfg = await settings(env);
            requireCredits(cfg);
            const b = peekSchema.parse(input),
              roomId = String(input.roomId),
              key = `peek:${roomId}:${u.id}`;
            if (await entryExists(env, key))
              return { purchased: true, charged: 0 };
            const view = unwrap(await roomStub(env, roomId).peekTarget(actor!));
            if (view.purchased) return { purchased: true, charged: 0 };
            requireThat(
              view.revealsAsl || view.revealsPicture,
              409,
              "There is nothing new to reveal",
            );
            requireThat(
              view.revealsAsl === b.revealsAsl &&
                view.revealsPicture === b.revealsPicture,
              409,
              "The reveal changed. Review it again before buying.",
            );
            const price = cfg.credits_peek_price,
              wallet = await walletOf(env, u.id);
            requireThat(wallet.balance >= price, 402, "Not enough credits");
            await env.DB.batch([
              ...spendStatements(env, u.id, "SPEND_PEEK", price, key, roomId),
              stmt(
                env,
                "INSERT INTO profile_peeks(room_id,viewer_id,subject_id,created_at) VALUES(?,?,?,?) ON CONFLICT(room_id,viewer_id) DO NOTHING",
                [roomId, u.id, view.subjectId, iso()],
              ),
              auditStatement(env, u.id, "credits.peek", roomId, {
                price,
                revealsAsl: view.revealsAsl,
                revealsPicture: view.revealsPicture,
              }),
            ]);
            await this.enqueue("event", {
              type: "room.changed",
              roomId,
              userIds: [u.id],
            });
            return {
              purchased: true,
              charged: price,
              balance: wallet.balance - price,
            };
          }
          case "credits.buy_slots": {
            requireThat(u?.verified, 403, "Verify your email to use credits");
            const cfg = await settings(env);
            requireCredits(cfg);
            const b = slotPurchaseSchema.parse(input),
              key = `slots:${b.clientOperationId}`;
            const wallet = await walletOf(env, u.id);
            if (await entryExists(env, key))
              return {
                purchased: false,
                extraContactSlots: wallet.extraContactSlots,
                balance: wallet.balance,
              };
            requireThat(
              cfg.credits_contact_slot_base +
                wallet.extraContactSlots +
                cfg.credits_contact_slot_pack <=
                cfg.credits_contact_slot_max,
              409,
              "Contact storage is at its maximum",
            );
            requireThat(
              wallet.balance >= cfg.credits_contact_slot_price,
              402,
              "Not enough credits",
            );
            await env.DB.batch([
              ...spendStatements(
                env,
                u.id,
                "SPEND_SLOTS",
                cfg.credits_contact_slot_price,
                key,
                null,
                [
                  slotIncrementStatement(
                    env,
                    u.id,
                    cfg.credits_contact_slot_pack,
                    key,
                  ),
                ],
              ),
              auditStatement(env, u.id, "credits.buy_slots", u.id, {
                slots: cfg.credits_contact_slot_pack,
              }),
            ]);
            const after = await walletOf(env, u.id);
            return {
              purchased: true,
              extraContactSlots: after.extraContactSlots,
              balance: after.balance,
            };
          }
          case "credits.order.create": {
            requireThat(u?.verified, 403, "Verify your email to buy credits");
            requireCredits(await settings(env));
            const b = creditOrderSchema.parse({ packId: input.packId });
            const pack = CREDIT_PACKS.find((p) => p.id === b.packId)!;
            const id = crypto.randomUUID();
            await run(
              env,
              "INSERT INTO credit_orders(id,user_id,provider,provider_reference,pack_id,credits,amount_minor,currency,state,created_at) VALUES(?,?,?,?,?,?,?,?,'PENDING',?)",
              [
                id,
                u.id,
                String(input.provider),
                String(input.reference),
                pack.id,
                pack.credits,
                pack.amountMinor,
                pack.currency,
                iso(),
              ],
            );
            return { id, packId: pack.id };
          }
          case "credits.order.settle": {
            // Internal: reached only from a verified provider webhook (no actor).
            requireThat(!actor, 403, "Internal command only");
            const order = await first(
              env,
              "SELECT * FROM credit_orders WHERE provider=? AND provider_reference=?",
              [String(input.provider), String(input.reference)],
            );
            requireThat(order, 404, "Order unavailable");
            // Replayed webhooks change nothing once an order has settled. A PAID
            // event is authoritative money movement, so it still credits an order
            // that expired or failed locally first; the topup entry key keeps it once.
            if (
              order.state === "PAID" ||
              (order.state !== "PENDING" && input.state !== "PAID")
            )
              return { state: order.state };
            if (input.state === "PAID")
              await env.DB.batch([
                ...grantStatements(
                  env,
                  order.user_id,
                  "TOPUP",
                  Number(order.credits),
                  `topup:${order.provider}:${order.provider_reference}`,
                  order.id,
                ),
                stmt(
                  env,
                  "UPDATE credit_orders SET state='PAID',settled_at=? WHERE id=? AND state<>'PAID'",
                  [iso(), order.id],
                ),
              ]);
            else
              await run(
                env,
                "UPDATE credit_orders SET state='FAILED',settled_at=? WHERE id=? AND state='PENDING'",
                [iso(), order.id],
              );
            return { state: input.state };
          }
          case "credits.grant": {
            // Internal: activity rewards delivered from Room outbox jobs.
            requireThat(!actor, 403, "Internal command only");
            const cfg = await settings(env);
            if (!cfg.credits_enabled) return null;
            const reward = String(input.reward);
            requireThat(reward === "activity", 400, "Unknown reward");
            const amount = cfg.credits_activity_milestone_reward,
              entryKey = String(input.entryKey);
            // Guests have no wallet; the reward is skipped, not retried.
            const target = await first(
              env,
              "SELECT verified FROM users WHERE id=?",
              [String(input.userId)],
            );
            if (!target?.verified || amount <= 0) return null;
            if (await entryExists(env, entryKey)) return null;
            if (
              (await activityGrantsToday(env, String(input.userId))) >=
              ACTIVITY_REWARDS_PER_DAY
            )
              return null;
            await env.DB.batch(
              grantStatements(
                env,
                String(input.userId),
                "GRANT_ACTIVITY",
                amount,
                entryKey,
                input.reference ? String(input.reference) : null,
              ),
            );
            return null;
          }
          default:
            throw new Error("Unknown application command");
        }
      }),
    );
  }
  private async issue(
    id: string,
    method?: "google",
    previousSessionHash?: string,
  ) {
    const t = token(),
      csrf = token(),
      signedInAccount = await user(this.env, id);
    const writes = [
      stmt(
        this.env,
        "INSERT INTO sessions(token_hash,user_id,csrf,expires_at) VALUES(?,?,?,?)",
        [await hash(t), id, csrf, iso(Date.now() + 604800000)],
      ),
    ];
    if (previousSessionHash)
      writes.push(
        stmt(this.env, "DELETE FROM sessions WHERE token_hash=?", [
          previousSessionHash,
        ]),
      );
    if (method && signedInAccount.role !== "USER")
      writes.push(
        auditStatement(this.env, id, "staff.sign_in", id, {
          method,
          role: signedInAccount.role,
        }),
      );
    await this.env.DB.batch(writes);
    return { user: publicUser(signedInAccount), csrf, token: t };
  }
  private roomRecord(
    id: string,
    type: RoomRecord["type"],
    creator: string,
    extra: any = {},
  ): RoomRecord {
    return {
      id,
      type,
      creator_id: creator,
      title: "Private conversation",
      description: "",
      category: "Conversation",
      region: "",
      tags: [],
      verified_only: false,
      slow_mode: 1,
      state: "OPEN",
      asl_revealed: false,
      created_at: iso(),
      last_activity: iso(),
      expires_at: null,
      closed_at: null,
      purge_at: null,
      version: 1,
      ...extra,
    };
  }
  // First-verification bonus. Empty while credits are disabled. The entry key makes repeats no-ops.
  private async verifyBonus(id: string): Promise<D1PreparedStatement[]> {
    const cfg = await settings(this.env);
    if (!cfg.credits_enabled || cfg.credits_verify_bonus <= 0) return [];
    return grantStatements(
      this.env,
      id,
      "GRANT_VERIFY",
      cfg.credits_verify_bonus,
      `verify:${id}`,
      null,
    );
  }
  private async create(
    record: RoomRecord,
    members: string[],
    invite: any,
    operationId = `room:${record.id}`,
    completion?: any,
    extra: D1PreparedStatement[] = [],
  ) {
    const old = await first(
      this.env,
      "SELECT payload FROM operations WHERE id=?",
      [operationId],
    );
    const payload = old
      ? JSON.parse(old.payload)
      : { record, members, invite, completion };
    if (!old)
      await this.env.DB.batch([
        stmt(
          this.env,
          "INSERT INTO operations(id,kind,payload,created_at) VALUES(?,?,?,?)",
          [operationId, "room.initialize", JSON.stringify(payload), iso()],
        ),
        stmt(
          this.env,
          "INSERT INTO app_outbox(id,kind,payload,created_at) VALUES(?,?,?,?)",
          [operationId, "room.initialize", JSON.stringify(payload), iso()],
        ),
        ...extra,
      ]);
    await this.ctx.storage.setAlarm(Date.now() + 1000);
    await this.deliverInternal(operationId);
  }
  async recoverRoom(id: string) {
    await this.ctx.blockConcurrencyWhile(async () => {
      const r = await first(
        this.env,
        "SELECT id FROM operations WHERE json_extract(payload,'$.record.id')=? AND state='PENDING'",
        [id],
      );
      if (r) await this.deliverInternal(r.id);
    });
  }
  async reserveMatch(a: string, b: string, expiresAt: number) {
    return this.ctx.blockConcurrencyWhile(() =>
      result(async () => {
        const env = this.env,
          cfg = await settings(env);
        const ua = await user(env, a),
          ub = await user(env, b);
        requireThat(
          a !== b &&
            (ua.verified || cfg.guest_access_enabled) &&
            (ub.verified || cfg.guest_access_enabled),
          403,
          "Match unavailable",
        );
        requireThat(!(await blocked(env, a, b)), 403, "Match unavailable");
        requireThat(
          (await env.USER_HUB.getByName(a).presence()).status !== "Offline" &&
            (await env.USER_HUB.getByName(b).presence()).status !== "Offline",
          409,
          "Match unavailable",
        );
        const existing = await first(
          env,
          "SELECT room_id FROM active_matches WHERE user_id IN (?,?)",
          [a, b],
        );
        requireThat(!existing, 409, "Already matched");
        const [x, y] = [a, b].sort();
        const rematchCooldownMs =
          (cfg.quickchat_rematch_cooldown_minutes ?? 5) * 60000;
        if (rematchCooldownMs > 0)
          requireThat(
            !(await first(
              env,
              "SELECT 1 FROM match_history WHERE user_a=? AND user_b=? AND matched_at>?",
              [x, y, iso(Date.now() - rematchCooldownMs)],
            )),
            409,
            "Recent match",
          );
        requireThat(Date.now() < expiresAt, 409, "Match search expired");
        const id = crypto.randomUUID(),
          record = this.roomRecord(id, "STRANGER", a, { slow_mode: 0 }),
          op = `match:${id}`,
          payload = { record, members: [a, b], invite: null, matched: true };
        await env.DB.batch([
          stmt(
            env,
            "INSERT INTO active_matches(user_id,room_id) VALUES(?,?),(?,?)",
            [a, id, b, id],
          ),
          stmt(
            env,
            "INSERT INTO operations(id,kind,payload,created_at) VALUES(?,?,?,?)",
            [op, "room.initialize", JSON.stringify(payload), iso()],
          ),
          stmt(
            env,
            "INSERT INTO app_outbox(id,kind,payload,created_at) VALUES(?,?,?,?)",
            [op, "room.initialize", JSON.stringify(payload), iso()],
          ),
          stmt(
            env,
            "INSERT INTO match_history(user_a,user_b,room_id,matched_at) VALUES(?,?,?,?) ON CONFLICT(user_a,user_b) DO UPDATE SET room_id=excluded.room_id,matched_at=excluded.matched_at",
            [x, y, id, iso()],
          ),
        ]);
        await this.ctx.storage.setAlarm(Date.now() + 1000);
        await this.deliverInternal(op);
        return { roomId: id };
      }),
    );
  }
  private effectStatement(id: string, kind: string, payload: any) {
    return stmt(
      this.env,
      "INSERT INTO app_outbox(id,kind,payload,created_at) VALUES(?,?,?,?) ON CONFLICT(id) DO NOTHING",
      [id, kind, JSON.stringify(payload), iso()],
    );
  }
  private async effect(
    kind: string,
    payload: any,
    writes: D1PreparedStatement[] = [],
    id = crypto.randomUUID(),
  ) {
    await this.env.DB.batch([
      ...writes,
      this.effectStatement(id, kind, payload),
    ]);
    await this.ctx.storage.setAlarm(Date.now() + 1000);
    await this.deliverInternal(id);
  }
  private async enqueue(kind: string, payload: any) {
    await this.effect(kind, payload);
  }

  async deliver(id: string) {
    await this.ctx.blockConcurrencyWhile(() => this.deliverInternal(id));
  }
  private async deliverInternal(id: string) {
    const item = await first(this.env, "SELECT * FROM app_outbox WHERE id=?", [
      id,
    ]);
    if (!item) return;
    const b = JSON.parse(item.payload),
      env = this.env;
    switch (item.kind) {
      case "room.initialize": {
        await roomStub(env, b.record.id).initialize(
          b.record,
          b.members,
          b.invite,
        );
        const writes = [
          stmt(env, "UPDATE operations SET state='DONE' WHERE id=?", [id]),
        ];
        if (b.completion) {
          const c = b.completion;
          writes.push(
            stmt(
              env,
              "UPDATE social_requests SET state='ACCEPTED',result_room_id=? WHERE id=? AND state='PENDING'",
              [b.record.id, c.requestId],
            ),
          );
          if (c.contact)
            writes.push(
              stmt(
                env,
                "INSERT INTO contacts(user_a,user_b,room_id) VALUES(?,?,?) ON CONFLICT DO NOTHING",
                [c.a, c.b, b.record.id],
              ),
            );
          writes.push(
            this.effectStatement(`request-event:${c.requestId}`, "event", {
              type: "request.responded",
              userIds: b.members,
              payload: { roomId: b.record.id, requesterId: c.requesterId },
            }),
          );
        }
        if (b.matched)
          writes.push(
            this.effectStatement(`match-event:${b.record.id}`, "event", {
              type: "matched",
              userIds: b.members,
              payload: { roomId: b.record.id },
            }),
          );
        writes.push(stmt(env, "DELETE FROM app_outbox WHERE id=?", [id]));
        await env.DB.batch(writes);
        await this.ctx.storage.setAlarm(Date.now() + 1000);
        return;
      }
      case "object.delete":
        await env.MEDIA.delete(b.key);
        break;
      case "room.close":
        await roomStub(env, b.roomId).closeInternal(b.actorId);
        break;
      case "event":
        for (const uid of b.userIds || [])
          await env.USER_HUB.getByName(uid).notify(b);
        break;
      case "pair.revoke": {
        for (const r of await all(
          env,
          "SELECT room_id FROM membership_index WHERE user_id=? AND room_id IN (SELECT room_id FROM membership_index WHERE user_id=?)",
          [b.a, b.b],
        ))
          await roomStub(env, r.room_id).revokePair(b.a, b.b);
        break;
      }
      case "user.revoke": {
        await env.USER_HUB.getByName(b.userId).offline(b.sessionHash);
        await env.MATCHER.getByName("charoo").cancelInternal(b.userId);
        for (const r of await all(
          env,
          "SELECT room_id FROM membership_index WHERE user_id=?",
          [b.userId],
        ))
          await roomStub(env, r.room_id).revokeUser(b.userId, b.sessionHash);
        break;
      }
    }
    await run(env, "DELETE FROM app_outbox WHERE id=?", [id]);
  }
  async alarm() {
    for (const r of await all(
      this.env,
      "SELECT id FROM app_outbox ORDER BY created_at LIMIT 50",
    ))
      try {
        await this.env.JOBS.send({
          source: "app",
          id: "charoo",
          operationId: r.id,
        });
      } catch {}
    if (await first(this.env, "SELECT 1 FROM app_outbox LIMIT 1"))
      await this.ctx.storage.setAlarm(Date.now() + 60000);
  }
  async pictureScanAccess(id: string, attempt: string, operation: string) {
    return this.ctx.blockConcurrencyWhile(() =>
      result(() => pictureScanAccess(this.env, id, attempt, operation)),
    );
  }
  async cleanup() {
    const env = this.env;
    await this.ctx.blockConcurrencyWhile(async () => {
      await cleanupPictures(env);
      await env.DB.batch([
        stmt(env, "DELETE FROM sessions WHERE expires_at<=?", [iso()]),
        stmt(env, "DELETE FROM quick_chat_archives WHERE expires_at<=?", [
          iso(),
        ]),
        stmt(env, "DELETE FROM email_tokens WHERE expires_at<=?", [iso()]),
        stmt(env, "DELETE FROM oauth_flows WHERE expires_at<=?", [iso()]),
        stmt(
          env,
          "UPDATE credit_orders SET state='EXPIRED' WHERE state='PENDING' AND created_at<?",
          [iso(Date.now() - 86400000)],
        ),
        stmt(
          env,
          "UPDATE social_requests SET state='REJECTED' WHERE state='PENDING' AND expires_at<=? AND NOT EXISTS(SELECT 1 FROM operations WHERE id='request:'||social_requests.id AND state='PENDING')",
          [iso()],
        ),
      ]);
      const expired = await all(
        env,
        "SELECT u.id FROM users u WHERE verified=0 AND guest_expires_at<=? AND NOT EXISTS(SELECT 1 FROM profile_pictures p WHERE p.owner_id=u.id) AND NOT EXISTS(SELECT 1 FROM room_index r WHERE r.creator_id=u.id) AND NOT EXISTS(SELECT 1 FROM membership_index p WHERE p.user_id=u.id) AND NOT EXISTS(SELECT 1 FROM operations o,json_each(o.payload,'$.members') m WHERE o.state='PENDING' AND m.value=u.id) LIMIT 50",
        [iso()],
      );
      for (const g of expired)
        await env.DB.batch([
          stmt(env, "UPDATE reports SET reporter_id=NULL WHERE reporter_id=?", [
            g.id,
          ]),
          stmt(env, "UPDATE reports SET target_id=NULL WHERE target_id=?", [
            g.id,
          ]),
          stmt(env, "UPDATE audit_logs SET actor_id=NULL WHERE actor_id=?", [
            g.id,
          ]),
          stmt(env, "DELETE FROM blocks WHERE user_id=? OR target_id=?", [
            g.id,
            g.id,
          ]),
          stmt(env, "DELETE FROM match_history WHERE user_a=? OR user_b=?", [
            g.id,
            g.id,
          ]),
          stmt(
            env,
            "DELETE FROM quick_chat_archives WHERE user_id=? OR peer_id=?",
            [g.id, g.id],
          ),
          stmt(
            env,
            "DELETE FROM social_requests WHERE requester_id=? OR target_id=?",
            [g.id, g.id],
          ),
          stmt(env, "DELETE FROM contacts WHERE user_a=? OR user_b=?", [
            g.id,
            g.id,
          ]),
          stmt(env, "DELETE FROM sessions WHERE user_id=?", [g.id]),
          stmt(env, "DELETE FROM email_tokens WHERE user_id=?", [g.id]),
          stmt(env, "DELETE FROM users WHERE id=? AND verified=0", [g.id]),
          this.effectStatement(`guest-expired:${g.id}`, "user.revoke", {
            userId: g.id,
          }),
        ]);
    });
    for (const r of await all(
      env,
      "SELECT id FROM room_index WHERE (state='OPEN' AND expires_at<=?) OR (state='CLOSED' AND purge_at<=?) LIMIT 100",
      [iso(), iso()],
    ))
      await roomStub(env, r.id).sweep();
    await this.alarm();
  }
}
