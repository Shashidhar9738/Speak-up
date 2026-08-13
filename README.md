# SpeakUp

Anonymous employee feedback, with an intelligence layer for leadership.

Employees report concerns with **no account and no login**. A rules engine
categorises each report, assigns a priority from its keywords, and extracts key
phrases. Leadership gets a dashboard that opens with what needs action today,
not a wall of counts.

---

## Status

| | |
|---|---|
| Source | https://github.com/Shashidhar9738/Speak-up |
| Local | `npm start` → http://127.0.0.1:3000 — **fully working** |
| GitHub Pages | https://shashidhar9738.github.io/Speak-up/ — **pages load, nothing works** |
| Hosted (working) | not deployed yet — `render.yaml` is ready |

### Why the GitHub Pages link does not work

GitHub Pages serves **static files only**. It has no Node runtime, so the entire
backend is absent. The HTML loads and then every API call fails:

```
GET  /index.html      → 200   (page renders)
GET  /api/health      → 404   (no backend)
POST /api/auth/login  → 405   (Pages rejects POST outright)
```

Sign-in, submissions, and the dashboard data all depend on that backend. The
Pages link is therefore a **broken shell**, not a demo — it will show an empty
dashboard and a login that always fails.

To get a working URL, deploy to a Node host (see *Deploying* below). Either turn
Pages off, or keep it only as a link to the repo.

---

## Running locally

```bash
git clone https://github.com/Shashidhar9738/Speak-up.git
cd Speak-up
npm install
cp .env.example .env      # then edit — see below
npm start
```

Open **http://127.0.0.1:3000**.

`npm run dev` restarts on file changes. The API also serves the pages, so there
is one process and one port — do not open the HTML files directly or serve them
from a separate static server, or every API call will 404.

### Minimum `.env`

```bash
SPEAKUP_ADMIN_EMAILS=you@yourcompany.com     # bootstrap owner accounts
SPEAKUP_ADMIN_DOMAINS=yourcompany.com        # who may register at all
SPEAKUP_ADMIN_SECRET=<48+ random bytes>      # see below
```

Generate the secret:

```bash
node -e "console.log(require('crypto').randomBytes(48).toString('hex'))"
```

In development an ephemeral secret is generated at boot if you omit it (so
sessions do not survive a restart). With `NODE_ENV=production` the app
**refuses to start** without one — a committed default secret would let anyone
forge an owner token.

A fresh clone starts with **no data**: `backend/data/` is gitignored, so real
complaints and account records never enter version control.

---

## The three surfaces

| Page | URL | Who | Auth |
|---|---|---|---|
| Submit | `/submit.html` | any employee | none |
| Track | `/track.html` | the reporter | ticket ID + access code |
| Dashboard | `/login.html` | leadership | email + password |
| Accounts | `/users.html` | owners only | email + password |

### How anonymity works

Nothing identifying is stored — no account, no email, no IP address. On
submission the reporter gets a ticket ID (`TKT-XXXX-XXXX`) and a one-time access
code. Only a SHA-256 hash of the code is kept, so:

- the reporter can return and check status, or exchange messages with leadership
- nobody, including an owner, can link a report back to a person
- a lost code cannot be recovered — that is the same property that protects them

Reports can be edited by the reporter for 30 minutes (configurable), after which
the text is fixed so leadership is not acting on shifting content.

---

## Access model

Registration is limited to the configured email domains and requires email
verification. A verified address is auto-approved at the default role; owners
can change anyone's role at `/users.html`.

| Role | Sees | Sensitive categories | Complaint text | Export | Act | Manage users |
|---|---|---|---|---|---|---|
| `owner` | everything | yes | yes | yes | yes | yes |
| `reviewer` | everything | yes | yes | yes | yes | — |
| `lead` | own departments | **no** | yes | — | yes | — |
| `staff` | all departments | **no** | yes | — | — | — |
| `analyst` | all departments | **no** | **redacted** | — | — | — |

"Sensitive" means Harassment & Ethics and Security & Compliance. These are hidden
from department leads *regardless of department*, because those reports most
often name the lead.

Scoping is enforced server-side on every route. An out-of-scope report returns
`404`, not `403`, so the API cannot be used to confirm that a restricted report
exists.

---

## How a report is classified

There is **no AI or LLM**. It is a rules engine (`backend/src/services/`) using
word-boundary stem matching, so `pressur` matches pressure/pressured/pressuring.

1. **Category** — six keyword buckets; highest match count wins
2. **Sentiment** — positive vs negative stems, with negation handling
   (`not supportive` counts negative)
3. **Priority** — keyword tiers in `priorityService.js`, each with an SLA and a
   stated reason so a reviewer can see *why* something is P1
4. **Key phrases** — adjacent word pairs ranked above single words

| Priority | Target | Triggers |
|---|---|---|
| P1 | 24 hours | harassment, retaliation, discrimination, fraud, unsafe, threats |
| P2 | 5 working days | resignations, burnout, unpaid, ignored, repeated escalation |
| P3 | 30 days | everything else |

Every ticket carries its reason, e.g. `Matched P1 keyword: retaliation`.

Summaries are **extractive**: sentences are scored and the two most important
are selected. Nothing is rewritten, so no model and no network call is involved.
A sentence naming a consequence — someone resigned, HR did nothing, it is unsafe
— outranks one that merely reads well, which is why a report opening with
throat-clearing still surfaces its real point.

---

## Deploying

`render.yaml` is included. On [render.com](https://render.com): **New →
Blueprint → connect this repo**. It provisions HTTPS, a persistent disk for
`backend/data`, and a generated auth secret.

Set `SPEAKUP_ADMIN_EMAILS` in the Render dashboard — it is intentionally not in
the repo, because it names real people.

**Before real reporters use any deployment:**

- **HTTPS is mandatory.** Over plain HTTP, complaint text and session tokens
  cross the network in cleartext together with the submitter's IP — which
  defeats the anonymity the product promises. Render terminates TLS for you; set
  `SPEAKUP_BEHIND_TLS=true`.
- Data lives in JSON files. Fine for a pilot; move to a database for real volume.
- Verification emails need SMTP. Without it, production refuses registration
  rather than falling back to showing codes on screen.

---

## Scripts

```bash
npm start            # run
npm run dev          # run with auto-restart
npm test             # frontend tests (jsdom)
npm run build        # static bundle into dist/ (frontend only — no API)
```

## Configuration

| Variable | Default | Purpose |
|---|---|---|
| `PORT` | `3000` | listen port |
| `SPEAKUP_HOST` | `127.0.0.1` | `0.0.0.0` to expose beyond localhost |
| `SPEAKUP_ADMIN_SECRET` | — | token signing key; **required** in production |
| `SPEAKUP_ADMIN_EMAILS` | demo values | bootstrap owner accounts |
| `SPEAKUP_ADMIN_DOMAINS` | `comviva.com` | domains allowed to register |
| `SPEAKUP_AUTO_APPROVE` | `true` | `false` restores an owner approval queue |
| `SPEAKUP_DEFAULT_ROLE` | `staff` | role granted on self-registration |
| `SPEAKUP_EDIT_WINDOW_MINUTES` | `30` | how long a reporter may edit |
| `SPEAKUP_TOKEN_TTL_HOURS` | `12` | session lifetime |
| `SPEAKUP_CORS_ORIGIN` | `*` dev / same-origin prod | allowed origin |
| `SPEAKUP_BEHIND_TLS` | `false` | set when a proxy terminates HTTPS |

Full API inventory: `GET /api/todo/apis`, or see `API_TODO.md`.
