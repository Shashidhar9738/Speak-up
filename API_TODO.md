# SpeakUp API To-Do List

Date: 2026-08-13

## Implemented (27)

- [x] `GET /api/health`  
  Health check
- [x] `POST /api/auth/login`  
  Allowlisted admin login
- [x] `POST /api/auth/validate`  
  Bearer token validation
- [x] `POST /api/auth/logout`  
  Client logout helper
- [x] `POST /api/auth/register`  
  Domain-restricted access request
- [x] `POST /api/auth/verify`  
  Email verification code exchange
- [x] `GET /api/auth/registration-status`  
  Registration state lookup
- [x] `GET /api/admin/users`  
  Owner-only account list
- [x] `POST /api/admin/users/:email/decision`  
  Owner-only approve/reject/revoke
- [x] `GET /api/auth/me`  
  Authenticated admin profile
- [x] `POST /api/submissions`  
  Anonymous submission intake with enrichment
- [x] `GET /api/submissions/:id`  
  Single submission detail
- [x] `POST /api/submissions/:id/status`  
  Status workflow update
- [x] `GET /api/submissions/:id/messages`  
  Submission message thread
- [x] `POST /api/submissions/:id/messages`  
  Append message thread item
- [x] `POST /api/track/:id`  
  Anonymous reporter status tracking via access code
- [x] `POST /api/track/:id/messages`  
  Anonymous reporter reply via access code
- [x] `POST /api/track/:id/edit`  
  Reporter edits own report inside the edit window
- [x] `GET /api/priority-tiers`  
  Keyword to priority mapping and colour codes
- [x] `GET /api/dashboard/submissions`  
  Filtered admin submission feed
- [x] `GET /api/dashboard/metrics`  
  Dashboard aggregate payload
- [x] `GET /api/dashboard/categories`  
  Category distribution payload
- [x] `GET /api/dashboard/trends`  
  Trend-only payload
- [x] `GET /api/dashboard/heatmap`  
  Department heatmap payload
- [x] `GET /api/dashboard/alerts`  
  High-priority alerts payload
- [x] `GET /api/dashboard/export.csv`  
  CSV export
- [x] `GET /api/todo/apis`  
  API inventory and backlog

## Remaining Backlog (5)

- [ ] `GET /api/dashboard/export.pdf`  
  Leadership PDF export — Phase 2
- [ ] `POST /api/auth/sso/callback`  
  Enterprise SSO callback — Phase 3
- [ ] `POST /api/integrations/hris/webhook`  
  HRIS synchronization — Phase 3
- [ ] `POST /api/submissions/:id/escalate`  
  Compliance escalation workflow — Phase 3
- [ ] `GET /api/compliance/audit-log`  
  Compliance audit trail — Phase 3

## Known gaps

- No HTTPS. Complaint text and session tokens cross the network in cleartext,
  along with the submitter's IP. Required before real reporters use this.
- No SMTP. Verification codes are shown on screen in development; production
  refuses registration until email delivery is configured.
- `summarize()` truncates at the first sentence boundary rather than
  summarising. An extractive replacement is prototyped but not merged.
- Data lives in JSON files, not a database.
- No automated test suite in the repo.
