# SpeakUp Software Requirements Check

Date: 2026-08-07

## Source Notes
- `SPEAKU_2.MD` is mostly business/market requirements.
- Technical software stack is primarily defined in `SPEAKU_2_ARCHITECTURE.md`.

## Checked Software Status

| Software | Why it matters | Status | Version/Details |
|---|---|---|---|
| Node.js | Backend runtime option | Installed | v24.0.1 |
| npm | Package manager for Node stack | Installed | 11.3.0 |
| npx | Runs local tools/scripts | Installed | 11.3.0 |
| Express | Backend API framework selected in project | Installed (project dependency) | express@5.2.1 |
| Python | Alternative backend/AI runtime option | Installed | Python 3.13.7 |
| pip / pip3 | Python package install tool | Missing in PATH | Not found in PATH |
| .NET SDK | Alternative backend runtime option | Missing | Not found in PATH |
| PostgreSQL client (`psql`) | DB option from architecture | Missing | Not found in PATH |
| MongoDB server (`mongod`) | DB option from architecture | Missing | Not found in PATH |
| MongoDB shell (`mongosh`) | DB management shell | Missing | Not found in PATH |
| SQLite CLI (`sqlite3`) | Lightweight DB option | Missing | Not found in PATH |
| Git | Source control | Installed | git version 2.45.1.windows.1 |

## MVP Recommendation for This Machine
1. Use Node.js + Express (already ready).
2. Use file-based JSON storage first (already possible) OR install SQLite as next DB step.
3. Skip .NET/PostgreSQL/MongoDB for now unless you choose those paths.

## Setup To-Do
- [ ] Confirm final backend stack: Node/Express (recommended now).
- [ ] Choose one DB path:
  - [ ] SQLite (lightweight MVP), or
  - [ ] PostgreSQL, or
  - [ ] MongoDB.
- [ ] If Python NLP is needed, fix pip availability in PATH.
- [ ] Add environment config (`.env`) for admin allowlist, token secret, and runtime settings.
- [ ] Complete API implementation and endpoint contract validation.
