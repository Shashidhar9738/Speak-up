# Working on SpeakUp

This project is an anonymous employee feedback and leadership intelligence system. The purpose is simple: an employee can submit a concern without creating an account, leadership can review the signal, and the platform can surface patterns before they become a problem.

This file exists to preserve the project context that is easy to lose in a codebase: the architecture, the guardrails, the delivery plan, and the prompts used to drive implementation. It is meant to be read before modifying backend behavior or changing product assumptions.

---

## Project direction

SpeakUp is not a generic survey tool. It is a trust-focused reporting platform designed for employee concerns, category detection, risk triage, and leadership visibility. The system prioritizes anonymity, readable signal, and operational clarity over user-facing polish alone.

The product has three core layers:

1. Public intake for anonymous reporting
2. Backend processing for validation, persistence, classification, and access control
3. Leadership dashboard for review, action planning, and pattern detection

The design is intentionally lightweight. The product is built to work with minimal operational overhead while keeping the core principles intact: privacy, traceable decisions, and defensible reporting.

---

## Architecture overview

### 1. Public submission surface

The public side is intentionally low-friction. Employees can submit a complaint or concern with no login, no account setup, and no identifying details. This keeps the barrier to reporting low while preserving the trust model of the system.

Responsibilities:
- render the anonymous submission page
- validate required input fields
- generate the ticket reference and access code
- send the submission to the backend API
- keep the experience simple and confidence-building

### 2. Backend API layer

The backend is the system of record. It owns validation, storage, access control, routing, auditability, and admin workflows. This is where trust is enforced.

Responsibilities:
- accept complaint submissions
- validate content using project-specific rules
- persist the report and metadata
- classify the report by category, sentiment, and priority
- restrict access by role and scope
- provide admin and leadership endpoints

### 3. Analytics and classification engine

This is the intelligence layer. It does not depend on a heavy AI stack or external model call. Instead, it uses rule-based classification, phrase extraction, and pattern detection to produce explainable insight.

Responsibilities:
- categorize reports into issue types
- score priority and sentiment
- detect important phrases and repeated themes
- build pattern summaries such as repeated issues or rising trends
- generate action-oriented summaries without rewriting the original content

### 4. Leadership dashboard

The dashboard is designed around decisions, not just counts. Leadership should see what is urgent now, what patterns are emerging, and what action is required.

Responsibilities:
- show metrics and trends
- highlight urgent and repeated issues
- display patterns and priorities with evidence
- allow review and response tracking
- keep sensitive data appropriately scoped by role

### 5. Admin and access control

Admin features are intentionally protected and scoped. The product distinguishes between anonymous reporting and internal review access. Leadership access is role-based and must be enforced server-side.

Responsibilities:
- validate users and roles
- allowlist access by domain or configured admin identities
- restrict data visibility by department and sensitivity
- protect sensitive categories from inappropriate exposure
- maintain operational security without compromising anonymity

---

## How the report moves through the system

1. An employee opens the public submission flow.
2. They write a report and receive an access code and ticket ID.
3. The submission is sent to the backend API.
4. The backend validates, stores, and classifies the content.
5. The analytics layer extracts key phrases, adds priority, and flags patterns.
6. Leadership sees the relevant metrics and reports through the dashboard.
7. Action plans and follow-up can be tracked without identifying the reporter.

This is the operational loop that matters: report -> classification -> visibility -> action -> follow-up.

---

## Critical project guardrails

These are the rules that matter most and are easy to break.

### Database safety

Anything that boots the app may write to the live complaint database unless the environment variable is set first.

The app resolves its database path once at require time using `SPEAKUP_DB_FILE`. If it is not set, it falls back to the live path. This is a real risk, not a theoretical one.

Use this pattern in tests and temporary scripts before requiring the app:

```js
process.env.SPEAKUP_DB_FILE = path.join(sandbox, "test.db");
const app = require("../src/app");
```

This pattern is already used in the backend tests for a reason. Do not assume `NODE_ENV=test`, `DATA_DIR`, or any other variable isolates the database. They do not.

On Windows, cleanup must also account for open file handles. Close the database before deleting the sandbox file, and wrap the removal in a try/catch.

### Error handling

Errors must go through `next(createHttpError(...))` rather than being sent directly. The project enforces a controlled error shape with `{ error }` and optional `{ details }`, and it exposes messages only when the error is explicitly marked as safe.

This matters because internal driver, parser, or mail errors may contain file paths, credentials, or connection strings. Those must never leak to the client.

### Text handling

Request text should be read through the project helpers such as `readText` and `normalizeText`. Do not coerce user input with plain `String(...)` calls on arrays or mixed value types. That can silently transform malformed input into valid-looking text and bypass validation.

Password handling is especially sensitive. Trimming a password changes the value and is not acceptable.

### Role semantics and session safety

`details.reason` on auth failures is not decoration. The frontend uses it to determine whether the session is expired. The same field must not be used for policy refusals such as “your role cannot export.” That would make a legitimate role check look like an expired session.

### Express-specific gotchas

This project uses Express 5, not Express 4.

- async route errors are forwarded automatically
- query parsing is the `simple` parser, not `qs`
- `app.router` is the router; `app._router` is not the right object

These are not optional details. They affect behavior and debugging.

### Repository rules

- Files are CRLF, so scripts that match multi-line strings must respect that
- `dist/`, `node_modules/`, `backend/data/`, `.env`, and `CREDENTIALS.md` are ignored
- `backend/data/` must never be committed because it contains complaint text and password hashes

---

## Running the project

```bash
npm install
npm start
npm run dev
npm test
```

Use the explicit test file list in the package script instead of passing a directory to Node's test runner. This project has separate suites for API, UI, and client behavior, and they are intentionally different.

The three suites cover different responsibilities:

- `api.test.js` boots the server and validates the HTTP contract
- `ui.test.js` renders pages in jsdom and verifies what the user actually sees
- `client.test.js` runs the frontend client logic against a fake fetch layer

There is no linter or formatter enforced by the repo, so match the surrounding code style. This is a backend-first project with no framework beyond Express and no build step for the Node API itself.

---

## Project workstreams

### Workstream 1: anonymous submission flow

This is the front door of the product.

Scope:
- create the anonymous form
- validate input and protect against bad payloads
- generate the ticket ID and access code
- store the report in a safe and minimal structure
- allow reporter follow-up without exposing identity

Quality bar:
- no account is required
- submissions are stored without identifying metadata
- the reporter can return and track the ticket securely

### Workstream 2: backend and API contract

This is the system foundation.

Scope:
- route design and HTTP contract
- validation middleware
- auth and session checks
- role-based access rules
- audit and service orchestration

Quality bar:
- requests are validated consistently
- auth failures are correctly shaped
- role restrictions do not leak sensitive existence information
- the API contract remains stable across upgrades

### Workstream 3: classification and intelligence

This is the product differentiator.

Scope:
- category detection
- priority scoring
- sentiment handling
- key phrase extraction
- summarization without generative rewriting
- repeated issue and trend detection

Quality bar:
- outputs are explainable
- priority reasons are explicit and reviewable
- rules are transparent and not hidden behind vague labels

### Workstream 4: dashboard and leadership visibility

This is the decision layer for leadership.

Scope:
- metrics overviews
- trends and aggregation
- category distribution and issue detail
- pattern summarization and action visibility
- department-aware and role-aware presentation

Quality bar:
- leadership sees actionable insight, not raw noise
- sensitive reporting remains correctly filtered
- every pattern is explainable and defensible

### Workstream 5: admin and user management

This is the trust and governance layer.

Scope:
- owner and reviewer access flows
- role assignment
- department scoping
- secure user registration and verification
- admin actions and review behaviors

Quality bar:
- only authorized people can access internal tools
- access is constrained and auditable
- the product does not create privacy or trust regressions

### Workstream 6: deployment and operations

This is the environment layer.

Scope:
- static frontend hosting on GitHub Pages
- API hosting on Render or similar Node platform
- environment variables and CORS configuration
- host binding and secure startup settings
- database persistence planning and operational risk management

Quality bar:
- the app works in a deployed environment
- frontend and backend talk to the right origin
- the app does not silently fail in production because of host or CORS assumptions

---

## Delivery plan

### Phase 1: MVP foundation
- define the product schema and intake flow
- implement anonymous submission and storage
- wire the backend API and basic validation
- create the admin and role model
- establish the dashboard baseline

### Phase 2: intelligence layer
- add category and sentiment rules
- implement priority scoring and phrase extraction
- build repeated issue and trend detection
- surface pattern explanations to leadership

### Phase 3: operational maturity
- harden access logic and data scoping
- improve admin workflows and audit quality
- validate deployment assumptions and persistence strategy
- review compliance, privacy, and reliability risks

---

## Product and planning prompts

These prompts are useful as starting points for planning, architecture work, or implementation. They keep the work focused on the actual product goals rather than drifting into generic backend or UI tasks.

### Prompt 1: product planning

> We are working on SpeakUp, an anonymous employee feedback and leadership intelligence product. Build a refined product plan that covers the anonymous submission flow, backend processing, role-based leadership access, risk and pattern detection, and the governance concerns around privacy and trust. Keep the plan practical, product-oriented, and focused on the MVP first.

### Prompt 2: architecture review

> Review the SpeakUp architecture and propose a clean technical structure for frontend, backend, analytics, and dashboard responsibilities. Include data flow, access boundaries, privacy implications, and the constraints that matter for a low-friction anonymous reporting system. Keep the design simple, explainable, and operationally realistic.

### Prompt 3: backend implementation

> Implement the backend logic for anonymous complaint submission, validation, role-scoped access, and classification output. Preserve the project’s conventions around secure error handling, request text normalization, and server-side authorization. Keep the solution aligned with the existing Node/Express architecture.

### Prompt 4: dashboard refinement

> Design the leadership dashboard for SpeakUp with a focus on urgency, patterns, high-signal findings, and explainable reporting. The dashboard should help leadership understand what is urgent today, what issues are recurring, and which departments or categories deserve attention without exposing sensitive details beyond the appropriate role.

### Prompt 5: deployment readiness

> Prepare the project for realistic deployment on a static frontend plus a hosted Node backend. Focus on CORS, host binding, environment variables, and the difference between local development and a live production origin. Ensure the deployment plan reflects the actual constraints of GitHub Pages and a backend service.

### Prompt 6: bug fix and investigation

> Investigate and fix the bug in SpeakUp with a focus on root cause, minimal scope, and validation. Start from the actual behavior, identify the failure point, and ensure that the fix respects project guardrails around privacy, auth, and the existing backend conventions.

---

## Implementation priorities

If the team is working in chunks, this is the recommended order:

1. anonymous submission and ticket flow
2. backend validation and persistence
3. auth, role guards, and access scoping
4. classification and issue intelligence
5. dashboard metrics and action visibility
6. deployment hardening and operational safety

This order reduces risk because the platform’s trust model and privacy assumptions are established before the intelligence layer is expanded.

---

## Final working notes

The project works because it is deliberately narrow and trustworthy: anonymous employees can report without friction, leadership can act with clarity, and the product remains explainable rather than opaque.

The biggest risk is not feature absence; it is accidental drift in trust boundaries. Preserve the anonymity model, enforce access at the backend, keep decision-making explainable, and never confuse a demo with a real deployment.

If a change is about data handling, auth, classification, or reporting behavior, it should be reviewed through the lens of privacy and operational correctness first, then through the lens of UI polish.
