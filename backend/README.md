# SpeakUp Backend

## Run

```powershell
npm run api:start
```

## Development

```powershell
npm run api:dev
```

## Default Admin Login

Use one of the default allowlisted emails unless you override `SPEAKUP_ADMIN_EMAILS`:

- `jane.doe@company.com`
- `admin@speakup.local`

## Environment Variables

See `.env.example`.

## Middleware

- Auth middleware protects admin-only routes using bearer tokens.
- Validation middleware checks login, submission, status update, and message payloads.
- Rate limiting middleware protects `POST /api/auth/login` and `POST /api/submissions`.
- Centralized error middleware returns consistent JSON errors for validation, rate limits, and unknown routes.

## Main API Surface

- `GET /api/health`
- `POST /api/auth/login`
- `POST /api/auth/validate`
- `GET /api/auth/me`
- `POST /api/auth/logout`
- `POST /api/submissions`
- `GET /api/submissions/:id`
- `POST /api/submissions/:id/status`
- `GET /api/submissions/:id/messages`
- `POST /api/submissions/:id/messages`
- `GET /api/dashboard/submissions`
- `GET /api/dashboard/metrics`
- `GET /api/dashboard/categories`
- `GET /api/dashboard/trends`
- `GET /api/dashboard/heatmap`
- `GET /api/dashboard/alerts`
- `GET /api/dashboard/export.csv`
- `GET /api/todo/apis`
