# Waypoint PRD v4: School-by-School Support Tracking

**Track:** Best Student Use Case · Berkeley × Stanford Grok Bot Hackathon  
**Date:** 2026-11-19  
**Status:** Draft for implementation  
**Related:** Builds on existing Waypoint (visa deadlines + federal/state policy via Scout)

## 1. Problem

Waypoint currently tracks federal visa rules (USCIS, State Department) and general policy changes. International students also live inside a specific school’s ecosystem:

- **Applicants** need to rank schools by how well they actually support international students (ISSS quality, DSO responsiveness, CPT/OPT help, emergency support, community, etc.), not just ranking or acceptance rate.
- **Enrolled students** need ongoing tracking of *that school’s* policies, ISSS announcements, travel-signature windows, local state rules that affect the campus, and changes in support that can affect status or experience.

Missing a school-specific deadline or a sudden ISSS policy change can be as costly as missing a federal one.

## 2. Goals

- Let a user add one or more target schools and receive a ranked view of their international-student support.
- Let a user set their current enrolled school and continuously track school-specific alerts and deadlines.
- Keep the same safety invariants: AI never does the scoring or day math; bots only collect and draft; user always approves anything that leaves the system.
- Fit cleanly into the existing 1 Manager + 4 worker Grok Bot architecture and MCP connector.

## 3. Non-Goals (for this version)

- Full real-time scraping of every school portal or authenticated student systems.
- Legal advice or guaranteeing visa outcomes.
- Automated application submission or form filling.
- Replacing federal tracking (this is additive).

## 4. User Stories

**As an applicant**  
- I can add 3–10 target schools (by name or search).  
- Waypoint ranks them by international support score with clear, sourced signals.  
- I see why one school ranks higher (e.g., lower student-to-advisor ratio, published emergency fund, strong recent student sentiment).

**As an enrolled student**  
- I mark one school as “current”.  
- The Daily Brief includes a “School” band with alerts relevant to my campus (ISSS policy changes, travel signature reminders, local state policy affecting the school, etc.).  
- Alerts can draft emails to the school’s ISSS or DSO that wait for my approval.

**As any user**  
- School data and alerts appear in Activity and can be turned off in Settings.  
- Nothing about my school is sent to anyone else without my explicit approval.

## 5. Ranking Model (Applicant Mode)

Score is **deterministic** (same inputs → same score). Bots collect raw signals; server code computes the score.

**Signals (examples, extensible):**

| Signal | Source | Weight direction |
|--------|--------|------------------|
| International student % | Open Doors / school site / US News | Higher can be positive (community) or neutral |
| Student-to-advisor ratio | School ISSS page | Lower is better |
| Dedicated ISSS office + appointment system | School site | Presence + quality indicators |
| Published CPT/OPT/STEM support (workshops, checklists) | School ISSS page | Presence |
| Emergency / hardship fund for internationals | School site or news | Presence |
| Recent student sentiment | X search + (optional) Reddit | Positive/negative ratio |
| State policy environment | Existing Scout logic + school state | Restrictive policies lower score |
| I-20 / document processing speed claims | School site | Faster is better |

**Output:**  
- Numeric score (0–100)  
- Rank among the user’s targets  
- 3–5 human-readable “why” bullets with source links  
- Last updated timestamp  

All math lives in a new pure function (similar to `clocks.js`). Bots never invent numbers.

## 6. Tracking Model (Enrolled Mode)

Once a school is marked “current”:

- Scout (or a focused School Scout path) watches:
  - Official ISSS / international office pages and news
  - X for the school name + keywords (“ISSS”, “international students”, “travel signature”, “CPT”, “OPT”, school handle)
  - Relevant state policy that affects that campus
- New MCP tool: `save_school_alert` (school id, title, why it matters, source url, risk, date)
- Manager pulls school alerts into the brief alongside federal deadlines.
- Messenger can surface them as texts or calendar events when appropriate.
- Optional: user can add school-specific dates (e.g., next travel signature window, program end date already in profile).

## 7. Data Model Changes

**Profile additions** (`lib/profile.js` + setup/settings UI):

```js
schools: [
  {
    id: "stanford",
    name: "Stanford University",
    status: "target" | "enrolled" | "alumni",
    unitid: "243744",          // optional IPEDS
    state: "CA",
    notes: "",
    added_at: "2026-11-19"
  }
]
```

**New tables / Redis keys:**

- `school_profiles/{slug}` — cached signals + computed score
- `school_alerts` — similar shape to existing policy alerts, scoped to person + school

**New rule-pack style data** (optional): school-specific clocks that only fire when the enrolled school is set (e.g., “travel signature recommended before trip”).

## 8. Bot & MCP Changes

### Existing Scout (preferred extension over new bot for hackathon speed)

Add to Scout’s role:

- When user has target or enrolled schools, also run school checks.
- Use browser + X search for school signals and alerts.
- Call new `save_school_signal` or `save_school_alert` tools.

### New MCP tools (server.js + lib/mcp.js)

| Tool | Used by | Purpose |
|------|---------|---------|
| `save_school_signal` | Scout | Raw signal for a school (type, value, source, date) |
| `save_school_alert` | Scout | Alert that should appear on brief |
| `list_schools` | Any bot | User’s schools and their status |
| `get_school_ranking` | Manager / UI | Computed ranks (read-only) |

Existing tools (`list_people`, `get_brief`, `report_run`, etc.) stay unchanged.

### Manager

- After workers report, also read school alerts and include them in the brief summary and email drafting when relevant (e.g., “draft email to ISSS about travel signature”).

### Messenger

- Can send “school_alert” kind texts and create calendar events for school-specific dates.

## 9. UI Changes

- **Setup / Settings:** New “Schools” step or section. Search or type school name, mark status.
- **Brief (`/`):**  
  - If targets exist: “School rankings” band with cards.  
  - If enrolled: “School” band with alerts (same visual language as federal deadlines).
- **Activity:** School research and alert runs appear with the Scout bot.
- **Connect page:** No change required if Scout is extended.

Keep the existing design system (tokens in `base.css`, Impeccable rules).

## 10. Technical Notes for Implementation

- Reuse the pure-function pattern: new `public/js/schools.js` (or `lib/schools.js`) for scoring and ranking.
- Seed data: add 2–3 sample schools for the demo people (Priya and Wei).
- Tests: extend `tests/` with scoring unit tests and a server test that a school alert appears on the brief.
- Demo path: “Show me the demo” should include at least one ranked school and one school alert so judges see the feature immediately.
- Sources must be stored with every signal/alert (url + label). Never invent data.
- Rate-limit and cache school page fetches so repeated runs are cheap.

## 11. Success Metrics (Hackathon)

- User can add a school and see a ranked result with sources in < 2 minutes of bot work.
- Enrolled school alert appears on the Daily Brief and can trigger a draft email.
- Existing federal flow remains unbroken (all previous tests still pass).
- Demo tells a clear story: “Federal rules + *my school’s* support, both watched for me.”

## 12. Open Questions

- Exact weighting of signals (can start with simple additive model and tune).
- Whether to surface a public “school support leaderboard” later (out of scope for v1).
- Depth of browser automation vs. curated seed data for the hackathon demo.

## 13. Suggested Implementation Order

1. Data model + profile UI for schools (target / enrolled).
2. Pure scoring function + unit tests.
3. New MCP tools.
4. Extend Scout instructions + first-message template.
5. Brief UI band for rankings and alerts.
6. Seed data + demo polish.
7. Manager/Messenger light integration for alerts.

---

**Next step:** Hand this PRD to Cursor with the existing repo open. Cursor should implement against the live codebase at `Vihaanbussa/waypoint-hackathon` (or the local clone) while preserving all existing safety and architecture invariants.
