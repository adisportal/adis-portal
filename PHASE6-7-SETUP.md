# Phase 6 & 7 — Setup Notes

This deploy adds the full "ADIS 2.0" UX overhaul (Phase 6) and the
automation engine + platform hardening (Phase 7). No new environment
variables beyond what Phase 4/5 already introduced — see
`PHASE4-5-SETUP.md` for `CLOUDINARY_*` and `CRON_SECRET`.

## 1. New cron endpoints (extend the existing pattern)

In addition to the fee-reminders and attendance-digest crons from Phase 5,
point your scheduler (cron-job.org or similar) at these two as well:

```
POST https://<your-app>.onrender.com/api/cron/automation-sweep?key=<CRON_SECRET>
POST https://<your-app>.onrender.com/api/cron/backup?key=<CRON_SECRET>
```

- **automation-sweep**: run this one at least hourly (it self-limits by
  time-of-day and per-rule cooldowns, so hitting it more often than once a
  day is safe and recommended — the 10:30 teacher-reminder check only
  fires once conditions are actually met).
- **backup**: once a day is plenty. It exports every collection to a single
  JSON file. If Cloudinary is configured it's uploaded there (folder
  `backups/`); otherwise it's written to `./backups/` on local disk, which
  — like uploads before Phase 5 — won't survive a Render redeploy. This is
  a logical JSON export, not a true `mongodump`; if you're on MongoDB
  Atlas, its own automated backups are the more robust option, and this is
  a supplementary safety net.

## 2. New admin screen: Automations

**Admin → Automations** — toggle each rule on/off per school:
- Remind teachers if attendance isn't submitted by 10:30
- Notify parents when attendance drops below 75%
- Remind students 1 day before homework is due
- Notify parents when homework goes repeatedly overdue (3+ days)
- Automatic fee reminders (controls the existing daily cron)
- Notify parents when a report card is released

All default to **ON** so behavior matches what already happened before
this deploy — toggling one off is opt-out, not opt-in.

## 3. What's new for each role

- **Home dashboard** (all roles except Owner, who keeps the Owner Panel):
  role-specific summary replacing the old generic Announcements landing.
- **Quick Action** button (bottom-right, the ➕): role-aware shortcuts.
- **Global Search** (admin): the header search box now does a real
  cross-entity search (students/teachers/classes) instead of an in-page
  filter.
- **Student Profile**: click any student's name in the Student Directory
  for a tabbed profile (Overview / Attendance / Homework / Marks / Fees /
  Activity), with a "Message Parent" shortcut for teachers.
- **Bulk actions**: multi-select checkboxes on the Student Directory —
  change class, notify parents, export CSV.
- **Homework**: templates + one-click duplicate for teachers.
- **Report cards**: a reusable comment bank feeds a "Remarks" field that
  now also appears on the PDF export.
- **Chat**: teachers get a quick-reply button with default + custom canned
  messages.
- **Attendance**: "Mark All Present/Absent" bulk buttons, and offline
  support — attendance taken with no connectivity is queued in the
  browser and synced automatically once the connection returns (look for
  the 🟡/✓ badge above the roster).
- **Mobile nav**: simplified to Home · Classes · Messages · More (the old
  individual tabs live inside "More" now, nothing was removed).

## 4. Monitoring & error logging (from Phase 7B)

- `GET /api/health` — unauthenticated, for an external uptime pinger.
- `GET /api/admin/error-log` — admin/owner can browse recent server
  errors the same way they browse the audit log.

## 5. New MongoDB collections introduced

`feePayments`, `homeworkTemplates`, `reportCardComments`,
`chatQuickReplies`, `automationRules`, `errorLogs`. All created
automatically on first write — no migration step needed.
