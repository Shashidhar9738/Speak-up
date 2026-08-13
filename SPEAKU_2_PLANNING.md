# SpeakUp Planning Sheet

## Project Objective
Build a lightweight anonymous employee feedback and whistleblowing intelligence product with zero-login submission, AI-driven issue extraction, and a CXO-ready leadership dashboard.

## Core Value Proposition
- Anonymous, zero-friction submission for employees
- AI-powered noise reduction and category extraction
- CXO-facing intelligence dashboard with trends, word clouds, and priority issues
- Position as a compliance-aware intelligence product, not a survey tool

## Target Users
- CXOs and leadership seeking early-warning employee risk signals
- HR and compliance teams needing anonymous intake and case visibility
- Mid-market and enterprise companies in India, Europe, UK, and the US

## Key Differentiators
- No app install, no login, no survey fatigue
- Real-time signal aggregation and issue prioritization
- Leadership-first dashboard, not a case-management heavy HR tool
- Positioned for whistleblower compliance and culture risk detection

## MVP Scope
### Must-have features
1. Anonymous submission form (web-based, no login)
2. AI auto-categorization of complaints/issues
3. Key-phrase extraction and issue summarization
4. Leadership dashboard with:
   - Total submissions
   - Trend metrics
   - Category/issue heatmap
   - Word cloud of top concerns
   - Priority issue list
5. Admin access via secure email allowlist
6. Basic complaint status tracking (open / acknowledged / resolved)

### Nice-to-have for MVP if time permits
- Simple two-way anonymous messaging
- Export to CSV/PDF
- Sentiment summary per issue or category
- Responsive mobile dashboard

## Phase Breakdown
### Phase 1 — Launch MVP (0-4 weeks)
- Define product schema and data model
- Implement anonymous submission flow
- Build basic AI categorization + summarization pipeline
- Create CXO dashboard with key stats and word cloud
- Add secure access and admin view
- Validate with sample submissions and walkthrough

### Phase 2 — Growth features (4-12 weeks)
- Add department/region heatmaps and sentiment
- Build trend analysis (week-over-week, category changes)
- Add incident priority scoring and alerting
- Add export/download capability
- Start whistleblower compliance readiness design

### Phase 3 — Compliance and integrations (12+ weeks)
- Deliver EU Whistleblower Directive compliance features
- Add HRIS and SSO/integration support
- Add multi-language support
- Add advanced anonymous escalation and reporting workflows

## Deliverables
- `SPEAKU_2_PLANNING.md` (planning sheet)
- Wireframe or HTML dashboard prototype
- MVP backend with submission ingestion and analytics
- Admin dashboard UI for leadership insights
- Data model and classification ruleset
- Pilot-ready demo

## Success Criteria
- Employees can submit anonymously in under 60 seconds
- Leadership dashboard updates within 10 seconds of new input
- Issues are grouped into categories automatically
- Product feels distinct from survey-only engagement tools
- The first pilot can run without requiring user accounts

## Risks and Mitigation
- Name conflict with existing SpeakUp brand: choose a new product name before launch
- Abuse/spam submissions: implement spam filtering and review moderation
- Privacy/trust concerns: enforce strict non-identification and minimal data retention
- Regulatory complexity: start with a pilot in less-regulated segments and add formal compliance later
- Competitor copy risk: move fast on MVP and build an AI/insights moat

## Initial Task List
1. Create project folder structure and README
2. Define data model for submissions, categories, and dashboards
3. Build anonymous web submission page
4. Develop backend ingestion and storage
5. Implement AI text summarization and category tagging
6. Build dashboard UI components
7. Create secure admin access flow
8. Test with sample cases and refine visuals
9. Capture feedback and iterate

## Agent-sized Work Objects
### Product & Design
- Define product name, brand, and positioning
- Create wireframes for anonymous submission and leadership dashboard
- Define the core data model and metadata schema

### Frontend
- Build the anonymous feedback submission page
- Build the CXO dashboard UI
- Implement responsive layout and component styling
- Add admin login / access controls

### Backend
- Create submission ingestion API and storage layer
- Implement status tracking (open / acknowledged / resolved)
- Build secure admin/email allowlist authentication
- Add basic analytics aggregation endpoints

### AI / Analytics
- Define category taxonomy and tagging rules
- Implement key-phrase extraction and issue summarization
- Build auto-categorization pipeline for incoming submissions
- Generate word cloud and trend-ready data

### Data & Reporting
- Design dashboard metrics and visual data structure
- Implement trend analysis and category heatmap data
- Add export/download support (CSV/PDF)
- Build reporting-ready summaries for leadership review

### Validation & Pilot
- Create sample data and end-to-end user flows
- Test submission-to-dashboard pipeline
- Validate anonymous behavior and data privacy
- Review workflow with pilot stakeholders

## Next Actions
- Confirm product name and branding direction
- Select technology stack for frontend, backend, and AI processing
- Create a minimal prototype for the anonymous submission + dashboard flow
- Align on first pilot target segment and success metrics

---

## Notes from Competitive Analysis
- Differentiation comes from frictionless anonymous intake and leadership-first insights
- Existing competitors are mostly HR-heavy or survey-heavy
- There is a strong gap for a product that surfaces voice-of-employee issues to CXOs without requiring onboarding or user accounts
