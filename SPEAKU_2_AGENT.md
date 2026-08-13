# SpeakUp Execution Agent

## Agent Name
**SpeakUp Implementation Agent**

## Purpose
This agent is the execution owner for the SpeakUp MVP. It coordinates design, frontend, backend, AI/analytics, reporting, and validation work to build a pilot-ready anonymous employee feedback platform.

## Responsibilities
- Accept the product plan and break it into concrete work items
- Implement the anonymous submission flow and leadership dashboard
- Build backend ingestion, storage, and secure admin access
- Create analytics pipelines for categorization, summarization, and dashboard metrics
- Validate the end-to-end experience with sample data and pilot-ready criteria

## Primary Work Streams
1. Product & Design
   - Confirm product name and positioning
   - Create wireframes for submission and dashboard flows
   - Define data model for submissions, categories, and analytics

2. Frontend
   - Build anonymous web submission page
   - Build CXO dashboard UI and components
   - Implement mobile-responsive layout and secure admin views

3. Backend
   - Create REST API for submission ingestion and status updates
   - Store submissions securely with minimal metadata
   - Implement authentication by allowlisted admin emails
   - Provide API endpoints for dashboard analytics

4. AI / Analytics
   - Define issue categories and tagging rules
   - Extract key phrases and summarize incoming text
   - Auto-categorize submissions and attach metadata
   - Produce dataset for word clouds, heatmaps, and trends

5. Data & Reporting
   - Define dashboard metrics and summary cards
   - Implement trend analysis and category heatmaps
   - Add export support for CSV/PDF summaries
   - Create leadership-ready dashboard reports

6. Validation & Pilot
   - Create sample submission data and test scenarios
   - Validate anonymous behavior and privacy properties
   - Test the full submission-to-dashboard pipeline
   - Document pilot success criteria and release readiness

## Agent Workflow
1. Review `SPEAKU_2_PLANNING.md`
2. Confirm the product scope and initial technical stack
3. Create a minimal prototype for the anonymous submission + dashboard flow
4. Complete one vertical slice from submission through analytics to dashboard visualization
5. Iterate with review and validation until MVP accepts pilot criteria

## Acceptance Criteria
- Anonymous submission works without login
- Dashboard displays real-time counts, category insights, and top issue signals
- AI categorization and phrase extraction run on each submission
- Admin access is restricted to allowlisted email addresses
- Data flow is validated end-to-end with sample submissions
- Pilot-ready documentation exists for next-phase rollout

## Coordination Notes
- Share API schema between frontend and backend before implementation
- Keep AI/Analytics data outputs consistent with dashboard needs
- Validate privacy controls early: no user identity stored or exposed
- Treat the leadership dashboard as the primary product experience

## Next Agent Task
- Create the first implementation plan for the anonymous submission page, backend API, and dashboard data contract.