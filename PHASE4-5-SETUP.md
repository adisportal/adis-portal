# Phase 4 & 5 — Setup Notes

This deploy adds: Audit Log UI, one-step admin onboarding, persistent file
storage (Cloudinary), real cron for fee reminders/attendance digests, and
Socket.io for real-time chat. Everything is **backward compatible** — if you
don't set any of the new env vars, the app runs exactly as it did before
(local disk uploads, admin-triggered reminders, polling-only chat).

## 1. Install new dependencies

```bash
npm install
```

This pulls in `cloudinary` and `socket.io`, added to `package.json`.

## 2. Persistent file storage (Cloudinary) — recommended

Local disk (`public/uploads/`) is wiped on every Render redeploy. To fix
this, create a free Cloudinary account (https://cloudinary.com) and set:

```
CLOUDINARY_CLOUD_NAME=your_cloud_name
CLOUDINARY_API_KEY=your_api_key
CLOUDINARY_API_SECRET=your_api_secret
```

With these set, announcement images and homework attachments upload to
Cloudinary and survive redeploys. Without them, the app silently falls back
to local disk — no code changes needed either way.

## 3. Real cron (fee reminders + attendance digest)

Set a secret key:

```
CRON_SECRET=some-long-random-string
```

Then point a free scheduler (e.g. https://cron-job.org) at these, once a
day each:

```
POST https://<your-app>.onrender.com/api/cron/fee-reminders?key=<CRON_SECRET>
POST https://<your-app>.onrender.com/api/cron/attendance-digest?key=<CRON_SECRET>
```

The existing 24-hour (fees) / 6-day (attendance) per-student cooldowns
already baked into `sendFeeReminder`/`sendAttendanceDigest` make daily
pings safe — most students will just be skipped until they're actually due.

If `CRON_SECRET` isn't set, these endpoints return `503` and do nothing —
the old admin-triggered "Remind All" / "Send to All" buttons still work
exactly as before regardless.

## 4. Socket.io (real-time chat)

No env vars needed — works automatically once deployed. Chat still polls
every 8s as a fallback (e.g. for networks that block websockets), but
messages now also push instantly via `/socket.io/socket.io.js`.

## 5. New UI

- **Audit Log** — new sidebar entry for Admin (own school) and Owner (all
  schools), with role/action/search filters.
- **Quick Onboard** — new card at the top of the Owner Panel: create a
  school and its first admin in a single form submission.

## What's still open after this deploy

- Sprint 1–4 UX overhaul (role-specific dashboards, quick actions,
  bulk actions, templates, automation rules) — not part of this deploy.
- `sw.js` bumped to **v7** for this deploy.
