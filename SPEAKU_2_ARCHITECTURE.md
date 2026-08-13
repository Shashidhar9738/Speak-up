# SpeakUp Architecture Plan

## Overview
This architecture plan defines the high-level system design for the SpeakUp anonymous feedback and whistleblowing intelligence product. It describes the main components, data flow, security controls, and deployment considerations for a pilot-ready MVP.

## Architecture Goals
- Fast, zero-login employee submission
- Secure anonymous handling of feedback data
- AI-driven categorization and summarization
- CXO-facing dashboard with actionable insights
- Clear separation of frontend, backend, analytics, and admin responsibilities
- Pilot-ready with minimal operational complexity

## Key Components
1. **Anonymous Submission Frontend**
   - Public web page for employees to submit feedback without login
   - Minimal fields: message, optional category/tag selection, optional department/region
   - Client-side validation and anti-spam controls
   - Submission POSTs to backend ingestion API

2. **Backend API Layer**
   - REST API for incoming submissions and admin operations
   - Endpoints:
     - `POST /api/submissions`
     - `GET /api/dashboard/metrics`
     - `GET /api/dashboard/submissions`
     - `POST /api/submissions/{id}/status`
     - `POST /api/auth/login` or `POST /api/auth/validate`
   - Handles data persistence and analytics orchestration

3. **Data Storage**
   - Primary storage for submissions and metadata
   - Minimal personal data; store only what is needed for analytics and status tracking
   - Example data model:
     - submissionId
     - messageText
     - category
     - summary
     - keywords
     - sentiment
     - status
     - createdAt
     - anonymousMetadata (browser locale, optional department)
   - Use a lightweight database such as PostgreSQL or MongoDB for MVP

4. **AI / Analytics Service**
   - Processes submitted text and enriches records
   - Functions:
     - key-phrase extraction
     - topic/category tagging
     - sentiment classification
     - summarization
   - Can be implemented as a separate microservice or backend module
   - Use locally hosted logic or a managed AI API depending on stack

5. **Dashboard Frontend**
   - Admin-facing UI for CXOs and compliance managers
   - Displays:
     - total submissions
     - trends over time
     - category distribution
     - word cloud / top phrases
     - priority issue list
     - recent submissions and statuses
   - Pulls metrics from backend analytics endpoints

6. **Authentication and Access Control**
   - Secure access for admin/dashboard users only
   - Use allowlist of admin emails or one-time tokens for pilot
   - Do not require employee login for submissions
   - Protect dashboard routes and API endpoints with auth middleware

7. **Deployment & Hosting**
   - Host frontend and backend on a single platform for MVP (e.g. Vercel + serverless API, AWS/Azure, or Heroku)
   - Use HTTPS everywhere
   - Store secrets in environment variables
   - Enable logging and basic monitoring

## Data Flow
1. Employee opens the anonymous submission page.
2. Employee submits a message.
3. Frontend sends the payload to `POST /api/submissions`.
4. Backend stores the raw submission and triggers analytics processing.
5. AI/Analytics enriches the submission with summary, keywords, category, and sentiment.
6. Dashboard frontend requests metrics from `GET /api/dashboard/metrics` and recent submissions from `GET /api/dashboard/submissions`.
7. Admin users view insights and update submission statuses as needed.

## Recommended Technology Stack
### Frontend
- Framework: React, Vue, or plain HTML/CSS/JS for fast MVP
- Styling: Tailwind CSS or lightweight custom CSS
- Charts: Chart.js, Recharts, or D3 for analytics visuals

### Backend
- Runtime: Node.js/Express, Python/Flask, or .NET minimal API
- Database: PostgreSQL, SQLite, or MongoDB
- Auth: JWT or simple email-based allowlist token
- AI: OpenAI / local NLP library / managed NLP service

### Analytics
- NLP: Python spaCy, Hugging Face transformers, or OpenAI embeddings
- Category rules: simple keyword mapping for MVP
- Trend engine: backend aggregation queries

## Security and Privacy
- Do not collect identifying employee data on submission.
- Encrypt data in transit (HTTPS) and at rest if possible.
- Limit dashboard access to allowlisted users.
- Implement a spam control layer (rate limiting, profanity filter, bot detection).
- Design data retention policy for pilot and keep only necessary records.

## Agent Handoff Points
- **Schema definition**: frontend, backend, and analytics must agree on submission shape
- **API contract**: expose dashboard metrics and submission endpoints clearly
- **Metadata contract**: define what AI outputs are stored and displayed
- **Validation criteria**: agree on success rules for pilot readiness

## MVP Architecture Diagram (Text)
- Browser -> Public Submission Page -> Backend `POST /api/submissions`
- Backend -> Database (raw submission)
- Backend -> AI/Analytics -> enriched submission data
- Admin Browser -> Dashboard Page -> Backend `GET /api/dashboard/*`
- Dashboard -> Metrics and recent submission endpoints
- Admin Browser -> Backend `POST /api/submissions/{id}/status`

## Next Steps
1. Finalize the technology stack and hosting platform.
2. Define the exact schema for submissions and analytics metadata.
3. Build the first vertical slice: anonymous submission -> backend save -> dashboard metric.
4. Add the analytics layer and category summarization.
5. Test the flow with sample data and review privacy controls.
