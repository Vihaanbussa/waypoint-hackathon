# Waypoint

**Every international student wakes up knowing their deadlines and next step, without checking anything themselves.**

Waypoint is a team of five AI helpers ("Bots", built with Grok Bot) for international students in the US, from the student visa (F-1) and work permit (OPT) through to the work visa (H-1B). Every night they check the government case-status site, the student's inbox and X, count the days to each deadline, and put what matters in the student's calendar and on their phone. Nothing is ever sent to another person unless the student approves it first.

- **Live site:** https://waypoint-5o4r.onrender.com (press "Show me the demo")
- **Hackathon:** Berkeley x Stanford Grok Bot Hackathon, **Track 02: Best Student Use Case**
- **Who it is for:** international students, starting with F-1 and OPT and carrying on to H-1B

---

## Inspiration

An international student does unpaid admin every week. They open the government case-status site to see if anything moved. They scan X, forums and school emails for rule changes. They dig dates out of PDFs, count unemployment days by hand, and write to HR or the international office. None of it has an alert or an API. A missed deadline can cost a student their legal status.

There were **1,177,766 international students in the US in 2024/25**, 294,253 of them on OPT ([Open Doors 2025](https://www.iie.org/news/open-doors-2025-press-release/)).

## What it does

Think of Waypoint as a small office that works while the student sleeps.

1. **Overnight**, a Manager Bot wakes up the others. One reads the case-status website. One searches X and official pages for rule changes and reads the student's email for dates.
2. **Waypoint's own code counts the days.** The AI never does date math, because AI gets dates wrong. Each deadline is marked *Act now* (14 days or fewer), *Watch* (45 or fewer) or *Clear*.
3. **The student wakes up to a one-page Brief:** what needs them now, every deadline grouped by urgency, and any emails already drafted for them.
4. **The student approves** any email to another person (HR, the international office) with one click. Texts and calendar events go only to the student, so they need no approval.

### The team: one Manager, four workers, one goal

| Bot | Role | What it does, in plain terms | When it runs |
| --- | --- | --- | --- |
| **Manager** | Manager | Owns the one nightly schedule. Starts the workers, waits for them, has Waypoint count the deadlines, drafts emails, holds them for the student's approval, then hands off to Messenger. | 2:00 AM every night, and when "Check now" is pressed |
| **Case Clerk** | Worker | Opens the case-status site like a person would and records the status word for word. It only reads. | When the Manager starts the night |
| **Scout** | Worker | Searches X and official pages (USCIS, State Department, Federal Register) for rule changes that apply to the student. Finds dates in mail from USCIS, the school and the employer. Also watches the student's school. It only reads. | When the Manager starts the night |
| **Messenger** | Worker | Texts the student, keeps one calendar event per deadline, and saves approved emails as Gmail drafts. | When the Manager hands off, and after an approval |
| **Intake Clerk** | Worker | Reads a photo or PDF of an immigration document (I-20, EAD card, I-797, I-94, DS-2019, passport) and says which field each value goes in. The student types it in. | When the student sends a document |

### Weekly chores replaced

| Weekly chore | Replaced by |
| --- | --- |
| Check case status on the government site | Case Clerk |
| Look for rule changes on X, forums and school emails | Scout |
| Find dates in notices and emails | Scout, Intake Clerk |
| Count days left, including unemployment days | Waypoint's code, shown by the Manager |
| Write to HR or the international office | Manager (drafts only) |
| Put deadlines in a calendar and get reminded | Messenger |

### What a student sees

| Page | What it is |
| --- | --- |
| **Brief** | "Priya, 1 deadline needs you now." Deadlines grouped as Act now, Watch and Clear, drafted emails waiting for approval, the latest Bot run, and the school section: target schools ranked on how well they support international students, plus notices from the student's own school. |
| **Activity** | Every Bot run and every message sent, newest first. |
| **Settings** | Profile, how to be notified (text, calendar, Gmail), the rules in use. |
| **Setup** | Three steps for a new account: visa type, your dates, how you want to be told. |

### Safety rules

These are enforced by Waypoint's server, so no Bot can talk its way around them.

- **No Bot does date math.** The tools refuse a day count. Days left, risk and school scores only come out of Waypoint's code.
- **Nothing reaches another person without approval.** A Bot can only save a draft. The server refuses to mark an email delivered unless the student approved it in the browser.
- **A post on X is never enough.** A rule change needs an official source, and Scout must list the X searches it ran or its run is rejected.
- **No ID numbers in a text.** Texts with a receipt number, or over 300 characters, are refused. A student gets at most 6 texts a day.
- **Waypoint writes the texts.** A Bot only picks the kind of message and the deadline. Waypoint writes the words, so the numbers are always right, and never sends the same news twice in a day.
- **A Bot's key opens one student's data and nobody else's**, and no template contains a key.
- **Read only where it matters.** Case Clerk never submits anything on a portal. Scout never replies to, forwards or deletes mail.
- **Not legal advice.** Waypoint organizes and alerts. Each rule links to the official source it comes from.

## Evidence

- **Real data:** deadline rules come from official pages (USCIS, Study in the States, the State Department), each with the date it was checked. Scout reads real public posts on X. **The case-status site in the demo is a mock and the two sample students are made up**, to protect real students' privacy.

## Try it

- **Live demo:** https://waypoint-5o4r.onrender.com, then "Show me the demo". It has two sample students: Priya (F-1 on OPT) and Wei (H-1B). The server sleeps when idle, so the first load can take up to a minute.
- **The 60-second tour:**
  1. Press "Show me the demo".
  2. Open `/portal/admin/` and change the case status to "Request for Evidence Was Sent" with a response date.
  3. Back on the Brief, press "Run a simulated Case Clerk check". Within seconds a new deadline appears under *Watch*, tagged New, with its day count.
  4. Approve the drafted email. It becomes a Gmail draft, ready to send.
  5. Switch to Wei Chen to see the same Bots follow a graduate on H-1B.

## Template links

One template per Bot, all open without signing in. No template contains a key; each one's first-run setup asks the new owner for their own key in a masked field and tells them to add the Waypoint connector at `https://waypoint-5o4r.onrender.com/mcp`.

| Bot | Template share link |
| --- | --- |
| Manager | https://x.ai/bot/jYDsF_XLTmGDAM1cmxTf- |
| Case Clerk | https://x.ai/bot/TuGI6owtPK-_2rvVhnCqi |
| Scout | https://x.ai/bot/rEMFD4TMgX8v2vJ_xv2jB |
| Messenger | https://x.ai/bot/EuYNcmgfkyJfJnOAURC9v |
| Intake Clerk | https://x.ai/bot/GWvDg0sSZiCdx1GXucMiv |

## How we built it

In plain terms: the Bots do the legwork, and a small website holds the facts, does the arithmetic and keeps the student in control.

| Piece | What it is |
| --- | --- |
| **The five Bots** | Grok Bots, each set up with one first message that states its job, where it looks, what it must never do, and the team's goal. The text of each is in [`bots/`](bots/). |
| **The connector** | A small server at `/mcp` (the MCP standard) that gives Bots seventeen tools to read the Brief and save what they find. The tools are where the safety rules live (`lib/bot-tools.js`). |
| **The rules engine** | One plain function turns a student's dates into deadlines. Every rule is a row of data: an anchor date, an offset, thresholds, a reason and an official source. A new visa type is new rows, not new code (`public/js/rules.js`, `public/js/clocks.js`). |
| **School ranking** | Bots collect raw facts about a school (advisor ratio, whether there is an international office, emergency funds, student sentiment). Fixed code turns those into a score, so the same facts always give the same score (`public/js/schools.js`). |
| **The website** | One Node 22 program with no dependencies and plain JavaScript pages, hosted on Render. Data is kept in Upstash Redis so it survives the free host's sleeps. |
| **Texts** | Twilio, called from the server. |
| **Tests** | `node --test`, run on every push by GitHub Actions. Covers the day counts, the rule packs and the whole server end to end. |

## Challenges we ran into

- **Bots get dates wrong.** So no Bot counts days: plain code does, and the tools refuse a day count.
- **Proving a Bot actually looked.** "No relevant changes" could mean it never searched. Scout now has to list its X searches or the run is rejected.
- **Six Bots on six timers was not a team.** Nothing coordinated them, and the rule-change check ran hours after deadlines were counted. The Manager now owns one schedule and every handoff.
- **Free hosting forgets.** The host wipes its disk when it sleeps, so accounts and Bot runs are saved to a database on every change.
- **Twilio trial accounts refuse custom wording.** Waypoint falls back to Twilio's sample texts and records the real line in Activity.

## Accomplishments

- A real loop from a status change on the case-status site to a deadline on the student's Brief, with every number traceable to a rule and an official source.
- An approval step enforced by the server, not by a Bot's good behaviour.
- Live text messages to a real phone, with the wording written by Waypoint rather than the AI.

## What we learned

- Dates are the riskiest thing to hand an AI, so the AI reads and drafts while plain code counts.
- Safety rules hold only when the server enforces them, not when a Bot's instructions ask nicely.
- One owner of the schedule beats several Bots on their own timers.

## What's next

- **More visa types.** Rule packs for J-1, O-1 and L-1 and the green-card path are already written in the code. They are not shown in the demo, and none has been tried with real students yet.
- **School tracking.** Target schools are ranked from facts Scout saves, and the enrolled school's notices appear on the Brief. Next: more schools and more signals.
- **Document upload.** Intake Clerk can read a document today when sent one in Grok Bot, but uploading from the site and approving by text are not built.
- **Real accounts.** Password reset and email verification.

## How Grok Bot helped build it

Grok Bot is also the product itself: the five Bots run on Grok Bot's own computers, so the student needs nothing installed.

## How to run it

You need Node 22 or newer. There is nothing to install.

```bash
node server.js
```

Open http://localhost:4173. On the sign-in page, create an account and enter your own dates, or press "Show me the demo".

To run the tests:

```bash
node --test
```

To let a Bot's computer reach your copy, run it on a public https address (a Bot cannot reach `localhost`):

```bash
HOST=0.0.0.0 PORT=8080 node server.js
```

Hosting, text messages, connecting real Bots, the connector's tools, the page list, the API and the design rules are in the **[technical reference](docs/TECHNICAL.md)**. The product spec for school tracking is in [`docs/`](docs/).

## What is not built

- The Bots themselves live in your own Grok Bot app, not in this repository. Until they are connected, the Brief shows sample runs and a simulated "Check now".
- Intake Clerk's document upload and approve-by-text.
- Messenger's calendar and Gmail work happens inside Grok Bot. The site offers a fallback: "Add to Google Calendar" on each dated deadline and a pre-filled Gmail window after approval.
- Password reset and email verification.
