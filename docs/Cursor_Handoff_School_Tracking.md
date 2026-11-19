# Cursor Handoff: Implement Waypoint School-by-School Tracking

## Context
You are working in the Waypoint repo (Vihaanbussa/waypoint-hackathon).  
Waypoint is a Grok Bot system that tracks federal visa deadlines for international students.  
We are adding **school-by-school** support tracking.

Full PRD: `docs/Waypoint_PRD_v4_School_Tracking.md`

## Core Invariants (do not break)
- AI never does date math or scoring math. Pure functions only.
- Bots collect and draft. User always approves anything that leaves the system.
- Existing federal deadline flow, tests, and MCP tools must keep working.
- No legal advice.

## Implementation Plan (do in this order)

### 1. Data model
- Extend profile in `lib/profile.js` and setup/settings UI to support a `schools` array:
  ```js
  { id, name, status: "target"|"enrolled"|"alumni", state?, unitid?, notes?, added_at }
  ```
- Add Redis/JSON storage for school signals and school alerts (mirror existing policy alert pattern).

### 2. Scoring engine
- Create `public/js/schools.js` (or `lib/schools.js`) with a pure `scoreSchool(signals)` and `rankSchools(userSchools, cachedProfiles)` function.
- Start with a simple weighted model (see PRD §5). Unit-test it.

### 3. MCP tools (server.js + lib/mcp.js)
Add:
- `save_school_signal`
- `save_school_alert`
- `list_schools`
- `get_school_ranking` (read-only, returns computed ranks)

### 4. Extend Scout
- Update `bots/scout.md` so Scout also checks the user’s target and enrolled schools using browser + X search.
- Scout calls the new save tools.
- Update the Scout first-message / template accordingly.

### 5. Brief UI
- Add a “School rankings” band (when targets exist) and a “School” alerts band (when enrolled school exists) on the Daily Brief (`public/js/brief.js` + HTML).
- Match existing visual language.

### 6. Manager + Messenger light integration
- Manager includes school alerts in the brief summary and can draft emails when appropriate.
- Messenger supports a new “school_alert” text kind.

### 7. Demo polish
- Seed 1–2 schools for the demo people (Priya/Wei) so the feature is visible on “Show me the demo”.
- Make sure all existing tests still pass; add new ones for scoring and school alerts.

## Deliverables
- Working feature on the Daily Brief
- Updated Scout bot instructions
- New tests
- Short note in README under “What’s next” or a new section

Start with the data model and scoring function so the rest can be built against a stable interface.
