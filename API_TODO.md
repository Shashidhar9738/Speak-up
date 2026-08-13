# SpeakUp API To-Do List

Date: 2026-08-07

## Implemented MVP APIs

- [x] `GET /api/health`
  Returns service health and timestamp.

- [x] `POST /api/auth/login`
  Accepts an allowlisted admin email and returns a signed bearer token.

- [x] `POST /api/auth/validate`
  Validates a bearer token supplied in the body or `Authorization` header.

- [x] `GET /api/auth/me`
  Returns the currently authenticated admin user.

- [x] `POST /api/submissions`
  Accepts anonymous employee submissions and enriches them with category, summary, keywords, sentiment, priority, and flags.

- [x] `GET /api/submissions/:id`
  Returns a single submission for authenticated admin users.

- [x] `POST /api/submissions/:id/status`
  Updates submission status to `open`, `acknowledged`, or `resolved`.

- [x] `GET /api/dashboard/submissions`
  Returns filtered admin submission list with query params:
  `status`, `category`, `sentiment`, `department`, `priority`, `search`, `limit`.

- [x] `GET /api/dashboard/metrics`
  Returns dashboard aggregates including totals, status counts, sentiment counts, category counts, weekly trend, department heatmap, top keywords, priority issues, and latest submissions.

- [x] `GET /api/dashboard/categories`
  Returns category breakdown as a focused payload for dashboard widgets.

- [x] `GET /api/dashboard/trends`
  Returns trend-only weekly volume data.

- [x] `GET /api/dashboard/heatmap`
  Returns the department complaint density heatmap payload.

- [x] `GET /api/dashboard/alerts`
  Returns urgent and high-priority issue alerts.

- [x] `GET /api/dashboard/export.csv`
  Exports filtered submissions as CSV for admin download.

- [x] `GET /api/submissions/:id/messages`
  Returns the admin-visible message thread for a submission.

- [x] `POST /api/submissions/:id/messages`
  Appends a message to the submission thread.

- [x] `POST /api/auth/logout`
  Client-side logout helper endpoint.

- [x] `GET /api/todo/apis`
  Returns a machine-readable API inventory and backlog.

## Remaining Backlog

- [ ] `GET /api/dashboard/export.pdf`
  PDF leadership export.

- [ ] `POST /api/auth/sso/callback`
  Enterprise SSO integration.

- [ ] `POST /api/integrations/hris/webhook`
  HRIS synchronization endpoint.

- [ ] `POST /api/submissions/:id/escalate`
  Compliance escalation workflow.

- [ ] `GET /api/compliance/audit-log`
  Audit trail for regulated deployments.
