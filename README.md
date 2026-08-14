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
| GitHub Pages | https://shashidhar9738.github.io/Speak-up/ — **demo mode**, sample data, nothing saves |
| Hosted (working) | not deployed yet — `render.yaml` is ready |

### What the GitHub Pages link is

GitHub Pages serves **static files only** — no Node runtime, so the backend is
absent and every API call would 404. Rather than ship a broken shell,
`assets/demo-mode.js` detects the missing backend and answers from sample data,
so the UI can be shown and shared.

It is a demo, not a deployment:

- a permanent banner says the data is not real
- nothing is saved; actions that would persist say so rather than pretending
- it activates **only** when `/api/health` is unreachable, so a real deployment
  is never silently replaced by sample data

For a working instance with real data and logins, deploy to a Node host — see
*Deploying*.

---

## What you need to run it

**Node.js 22 or newer.** That is the whole list.

SQLite is built into Node, so there is no database to install, no server
process to keep alive, and no cloud account. Email, webhooks and HTTPS are
optional and stay off unless configured.

```bash
git clone https://github.com/Shashidhar9738/Speak-up.git
cd Speak-up
npm install               # express + nodemailer
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

## Credentials

Working passwords are **not in this repository** — it is public, and a
deployed instance would then be open to anyone who found it.

They live in `CREDENTIALS.md`, which is gitignored and stays on the machine
that runs the app. That file lists the accounts, what each role can see, and
how to reset.

If you have cloned this and have no `CREDENTIALS.md`, create an account:

```bash
npm start
# then register at http://127.0.0.1:3000/register.html with a @comviva.com address
```

The first bootstrap owner comes from `SPEAKUP_ADMIN_EMAILS` in `.env`. To set
or reset a password directly:

```bash
node backend/scripts/set-password.js someone@comviva.com --generate
```

Passwords are scrypt hashes and cannot be read back, so this is the recovery
path rather than a lookup.

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
- Data lives in a SQLite file (`backend/data/speakup.db`). Back it up by copying it.
- Verification emails need SMTP (`SPEAKUP_SMTP_URL`). Without it, production
  refuses registration rather than falling back to showing codes on screen.

---

## Scripts

```bash
npm start            # run
npm run dev          # run with auto-restart
npm test             # frontend tests (jsdom)
npm run backup       # snapshot the database (see below)
npm run build        # static bundle into dist/ (frontend only — no API)

# reset a password (scrypt hashes cannot be read back)
node backend/scripts/set-password.js someone@comviva.com --generate
```

## Optional integrations

All three are off unless configured, and the app runs fine without them.

### Email

Used only for dashboard accounts — verification codes and password-change
alerts. **Never used to contact a reporter**, who has no address on file.

```bash
SPEAKUP_SMTP_URL=smtps://user:pass@smtp.gmail.com:465
SPEAKUP_MAIL_FROM=SpeakUp <noreply@comviva.com>
```

The connection is verified at boot, so a bad setting is a startup warning
rather than something the first person to register discovers.

### HRIS / ticketing webhook

Deliberately generic rather than written for one vendor: Workday, Darwinbox and
SAP all differ, and coding to one guesses wrong for the others. It posts a
documented envelope to a URL you choose.

```bash
SPEAKUP_WEBHOOK_URL=https://hris.example.com/hooks/speakup
SPEAKUP_WEBHOOK_SECRET=<shared secret>
SPEAKUP_WEBHOOK_EVENTS=submission.created,submission.escalated
```

**Complaint text is never sent.** The payload carries only what is needed to
open a ticket:

```
id, category, priority, sla, status, department, region,
sensitive, escalated, escalatedTo, createdAt, updatedAt
```

`messageText`, `summary`, `keywords`, `messages` and the access-code hash never
leave. A webhook lands in a system with different access rules, so anyone
wanting the substance must come back and read it here, where the role rules
still apply.

With a secret set, each request carries `X-SpeakUp-Signature: sha256=<hex>`, an
HMAC over the exact bytes sent. Verify it before trusting a payload.

`GET /api/integrations/hris/webhook` (owner only) returns the live contract.

### HTTPS

```bash
npm run tls:generate      # self-signed certificate for localhost
```

Then set `SPEAKUP_TLS_KEY` and `SPEAKUP_TLS_CERT`. If the files are missing the
server refuses to start rather than quietly serving plaintext — a setup that
looks encrypted and is not would be worse than an obvious failure.

A self-signed certificate encrypts the connection but proves nothing about who
is serving it, so browsers warn. Fine for development and a LAN demo; **not** a
substitute for a real certificate in front of real reporters.

---

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
| `SPEAKUP_DB_FILE` | `backend/data/speakup.db` | SQLite database |
| `SPEAKUP_AUDIT_FILE` | `backend/data/audit.log` | append-only audit trail |
| `SPEAKUP_REQUIRE_VERIFICATION` | `false` | `true` re-enables the email code on signup |
| `SPEAKUP_SMTP_URL` | — | enables outbound email |
| `SPEAKUP_WEBHOOK_URL` | — | enables the HRIS webhook |
| `SPEAKUP_WEBHOOK_SECRET` | — | signs webhook payloads |
| `SPEAKUP_TLS_KEY` / `_CERT` | — | serve HTTPS directly |

## Storage

SQLite, one file, no server. Six tables:

| Table | Holds |
|---|---|
| `submissions` | complaints; no column identifies the reporter, the access code is a hash |
| `messages` | the two-way thread on a submission |
| `users` | dashboard accounts; passwords are scrypt hashes |
| `appreciations` | recognition; names the recipient, and the nominator only if they chose |
| `notifications` | in-app notices waiting for a reporter |
| `rate_limits` | request counters, persisted so a restart does not reset them |

The **audit trail is deliberately not a table**. It is an append-only text file
at `backend/data/audit.log`, never served over HTTP and never shown in the UI:
a trail the app can rewrite is not a trail, and one readable from the dashboard
tells a curious admin who else has been reading which complaints.

```bash
node backend/scripts/migrate-json-to-sqlite.js   # one-off, safe to re-run
```

Full API inventory: `GET /api/todo/apis`, or see `API_TODO.md`.
