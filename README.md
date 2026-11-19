# Waypoint

Grok Bot teammates for life on a visa. This is the hackathon demo site from the Waypoint PRD v2: sign-in, a setup where you enter your own visa dates, the Daily Brief, Activity and Settings pages, a mock case-status portal for the Case Clerk Bot to read, and a report form for Bots to write through.

The demo people are fake.

## Run it

Needs Node 22 or newer. There is nothing to install.

```bash
node server.js
```

Then open http://localhost:4173. You land on the sign-in page, where you can create an account and enter your own dates, or press "Show me the demo" for the two sample people.

```bash
node --test
```

runs the tests: the PRD's sample day counts, the rule packs, and the server end to end.

To let a Bot's computer reach the site, run it on a host the Bot can reach (or behind a tunnel) with `HOST=0.0.0.0 PORT=8080 node server.js`.

## Pages

| Address | What it is | Who uses it |
| --- | --- | --- |
| `/login/` | The page before sign-in: sign in, create an account or open the demo, then scroll through one night with the Bots | Everyone |
| `/setup/` | Your own details in three steps: visa type, dates, how you are told | A new account |
| `/` | Brief: what needs you now, deadlines grouped by urgency, drafted emails, the latest Bot run | The person |
| `/activity/` | Every Bot run and message sent, newest first | The person |
| `/settings/` | Profile, notification channels, rules in use | The person |
| `/portal/` | Mock case-status portal with a sign-in | Case Clerk Bot |
| `/portal/admin/` | Change the portal status, rehearse, reset | The team |
| `/report/` | Form a Bot fills in after a run | Any Bot |
| `/connect/` | Connect your Bots: the connector address, your key, each Bot's first message | A signed-in person |
| `/mcp` | The Bot connector (not a page): a Grok Bot calls Waypoint's tools here | Grok Bots |

The portal sign-in is in `data/portal-users.json`. In the demo, add `?p=wei` to switch person and `?today=2026-11-18` to pin the date for a rehearsal.

## Accounts and your own data

- **Create an account** on the sign-in page, then answer three steps. Step two asks only for the dates your visa type uses, says which document each one is on, and shows the deadlines they create as you type.
- **Your Brief** is counted from those dates by the same rule packs as the demo. A new account starts empty: no sample deadlines, no sample Bot runs.
- **Add a deadline of your own** from the Brief for anything the rules do not cover (an appointment, a lease). Remove it there or in Settings.
- **Edit your details** from Settings. The deadlines recount at once.
- **Check now** on the Brief runs the two Bots that need no connection: Case Clerk reads the mock portal for your receipt numbers, and Deadline Keeper recounts. Both runs are labelled simulated. The other four Bots show "Not connected" until a real Bot reports.
- **Connect your Bots:** until an account's Bots are connected, the Brief says so in a black band right under the headline, with a "Set up your Bots" button ("Not now" puts it away until the next visit). The same section sits at the top of Settings. Both go quiet once a Bot has reported or Check now is wired to one. The demo never shows the prompt, since its sample people come with sample runs.

Passwords are stored hashed (scrypt, a salt per account) in `data/accounts.json`, which is never sent to a browser and is ignored by git. Sign-in is a signed, HttpOnly cookie that lasts 30 days. An account sees only its own profile and rows; the demo sees only the sample people. `data/dev-account.example.json` has a throwaway account to create for local testing.

`WAYPOINT_DEMO_ONLY=1 node server.js` skips sign-in and opens the sample people to anyone, for a public demo link.

## Where it is hosted

The site runs on Render's free plan at https://waypoint-5o4r.onrender.com, deployed from the `main` branch of this repository by `render.yaml`. Every push to `main` redeploys it.

- **It sleeps after 15 idle minutes.** The next request wakes it, which takes up to a minute. The Bots are told to wait a minute and retry once.
- **Its disk is wiped whenever it sleeps, restarts or redeploys.** Without a database, the sample people come back from `public/data/seed.json` but accounts people created and anything the Bots wrote are lost.
- **A database keeps the data.** Set `UPSTASH_REDIS_REST_URL` and `UPSTASH_REDIS_REST_TOKEN` (from a free Upstash Redis database) in the service's Environment tab. The site then saves the store and the accounts there on every change and reads them back on start (`lib/persist.js`). `/healthz` says whether a database is on.
- **Text messages go out through Twilio.** Set `TWILIO_ACCOUNT_SID`, `TWILIO_AUTH_TOKEN` and `TWILIO_FROM_NUMBER` (the number Twilio gave you, like `+15551234567`) in the Environment tab. Then Messenger's `send_text` tool and the "Send a test text" button in Settings send a real text to the person's own phone, and each one is recorded under Activity (`lib/sms.js`). Without the three settings nothing is sent and the page says so. A person gets at most 6 texts a day and the whole site 60 (`SMS_DAILY_CAP` changes that); a text over 300 characters or with a receipt number in it is refused. The sample people have made-up numbers, so their texts go nowhere unless `SMS_DEMO_TO` names a real phone, which is how a live demo gets a text. A Twilio trial only texts numbers verified in its console. `/healthz` adds "texts on" when it is set.
- **The Bots' key and sign-in secret survive**, because Render holds them as `WAYPOINT_BOT_KEY` and `WAYPOINT_SECRET` in the service's Environment tab.

## Connecting real Grok Bots

Grok Bots are set up in your own Grok Bot app; Waypoint cannot create them for you. What Waypoint gives them is a connector and a key.

1. **Put Waypoint on a public https address.** Grok Bots run on a cloud computer, so `localhost` is out of their reach. Free tunnels do not last (two were tried and both dropped within 20 minutes), so use a host.
2. **Open `/connect/`** (Settings, then "Set up your Bots"). It shows the connector address, your Bot key, and a message to paste into Grok Bot that adds Waypoint as a custom MCP server.
3. **Create the six Bots.** The same page has each Bot's first message, ready to copy: its job, where it looks, what it must never do, and when to run.
4. **Optional: wire Check now.** Ask Case Clerk for a webhook routine and paste its address and key on the page. Check now then wakes the real Bot instead of running the simulated check.

The connector is a small MCP server (`lib/mcp.js`, JSON-RPC over POST at `/mcp`) with twelve tools: `list_people`, `get_brief`, `report_run`, `save_case_status`, `save_policy_alert`, `save_inbox_date`, `set_deadline_note`, `draft_email`, `list_emails`, `mark_email_delivered`, `log_message`, `send_text`. The rules the tools enforce:

- Policy Watcher watches X. When it first sees a change there, it passes the post's link as `x_url`, and the Brief shows "First seen on X" beside "Confirmed by" and the official source. Only a link on x.com is kept, and a post alone is never enough: the official page is still what the notice rests on. Policy Watcher also has to show its work: `report_run` refuses a finished Policy Watcher run that does not list the searches it ran on X (`x_searches`) and how many posts it read (`x_posts_read`), and those appear under the run on the Brief and in Activity. If its X search is not working, the run is reported as failed instead.
- A key speaks for one account's person and nobody else. The key for the sample people is in `data/bot-key.txt`.
- Days left and risk come from `get_brief`, worked out by Waypoint's code. No tool accepts a day count.
- `draft_email` always saves a draft. `mark_email_delivered` refuses any email the person has not approved in the browser.
- Bots that write through `/report/` or `/api/rows/...` need the same key (or a signed-in browser).

This is tested two ways: by a hand-written client that speaks the protocol (see `tests/server.test.js`), and live. Six Grok Bots are connected to the hosted site with the key for the sample people, each has run once successfully, and five have a daily routine: Case Clerk 2:00 AM, Inbox Scout 2:10 AM, Deadline Keeper 2:30 AM, Messenger 3:00 AM, Policy Watcher 7:00 AM. Intake Clerk runs when it is sent a document.

For the demo account, Inbox Scout only reads emails whose subject contains `[Waypoint demo]`, and Messenger only acts for Priya.

## The 60-second demo

1. On the sign-in page, press "Show me the demo".
2. Open `/portal/admin/`, set the status to "Request for Evidence Was Sent" with a response date, and save.
3. Have the Case Clerk Bot sign in to `/portal/`, read the status, and report it at `/report/`. With no Bot connected, press "Run a simulated Case Clerk check" instead; the run is labelled simulated.
4. Within five seconds the Brief shows a new deadline under Watch, tagged New, with its day count.
5. Approve the drafted email. It folds into "Approved by you" with a link that opens it in Gmail, ready to send.
6. Switch the profile to Wei Chen to show the same Bots on the H-1B rule pack.

"Reset demo data" on the admin page puts everything back.

## How it is put together

- `public/js/rules.js` holds the rule packs. Every deadline is a row: an anchor date, an offset, thresholds, a reason and a source. A new visa type is new rows.
- `public/js/clocks.js` is the clock function. It turns a profile, the rule packs and the facts the Bots wrote into deadlines with days left and risk. It is plain code with no network or DOM, so the numbers are deterministic. Bots never do date math.
- `server.js` serves the pages and keeps the store in `data/store.json` (created from `public/data/seed.json`). It has no dependencies.
- The pages poll the store every five seconds. If the server is not there, they render the sample data and keep changes in the browser.

Risk: Act now at 14 days or fewer, Watch at 45 or fewer, otherwise Clear. A rule can override this (an evidence request and the H-1B grace period are at least Watch; the 10-day address clock is Act now).

## How Bots write

A Bot can fill in the form at `/report/` (it is a plain HTML form and works without JavaScript), or post JSON:

```bash
curl -X POST http://localhost:4173/api/rows/case_status -H 'Content-Type: application/json' -d '{"person":"priya","receipt":"IOE0912345678","title":"STEM OPT case","status":"Case Was Approved","last_changed":"2026-11-18"}'
```

| Table | Written by | Fields |
| --- | --- | --- |
| `runs` | every Bot | `person`, `bot`, `status` (ok, failed, running), `summary` |
| `case_status` | Case Clerk | `person`, `receipt`, `title`, `portal`, `status`, `last_changed`, `response_due` |
| `alerts` | Policy Watcher | `title`, `why`, `risk`, `visa_types` or `person`, `source_label`, `source_url`, `x_url` or `seen_on_x` |
| `inbox_facts` | Inbox Scout | `person`, `label`, `due_date`, `sender`, `subject`, `link` |
| `clock_notes` | Deadline Keeper | `person`, `clock`, `reason` (replaces the default wording) |
| `actions` | Deadline Keeper | `person`, `clock`, `recipient_label`, `to`, `subject`, `body` |
| `notifications` | Messenger | `person`, `channel` (sms, calendar, gmail), `text`, `state` |

A Bot can only draft an action. The server forces `state` to `drafted`, and only the Approve and Reject buttons change it.

### Reading from a Google Sheet instead

To follow the PRD's store decision, publish each tab as CSV and list the links in `data/config.json`:

```json
{ "sheet_csv": { "runs": "https://docs.google.com/spreadsheets/d/.../export?format=csv&gid=0" } }
```

Tables listed there are read from the sheet (header row = field names) and replace the local table. If a sheet does not answer, the last good rows stay on screen. This path is tested with sample CSV but has not been run against a real sheet.

## What is not built

- The Bots themselves, and Messenger's calendar and Gmail work, which happen in Grok Bot. The site gives those two channels a no-connector fallback: "Add to Google Calendar" on every dated deadline, and a prefilled Gmail window after approval. Texts are sent by the site through Twilio once its three settings are in place (see "Where it is hosted").
- Intake Clerk's document upload and approve-by-text.
- Creating the Bots: that happens in your own Grok Bot app. Until you do, the six Bots here are drawings, sample runs and the simulated Check now.
- The mock portal's pages are open to anyone who can reach the server, like the government site it stands in for.
- Password reset and email verification.

## Design rules

Black on white, one typeface (Atkinson Hyperlegible Next, chosen because 0/O and 1/l/I are easy to tell apart in dates and receipt numbers). Flat fills only: no gradients, no shadows, no blur.

- **Green, the accent:** black and white are the base, and one green (`--green`: `#0B8043` on white, `#2FCB73` on black) is spent on few things, the way one accent on a neutral site is meant to be used: (1) the main button of each screen, (2) where you are and what is chosen (the mark under the current place, ticks, checked boxes, the focus ring), (3) a Bot working right now (its ring and the packet it passes on), and (4) the brand (the centre of the logo and one phrase before sign-in). Rules, progress lines, risk marks and status words stay black. The sign-in form's own button is solid black (`btn--solid`) so the page has one green action, the demo. All of it lives in one block at the end of `public/css/app.css`.
- **The Bots' own colours:** each Bot is one pastel so the six can be told apart before a name is read: Intake Clerk butter `#FADD82`, Case Clerk sky `#96C8F8`, Policy Watcher lilac `#C8ADF3`, Inbox Scout peach `#FDBD87`, Deadline Keeper rose `#F7A3C6`, Messenger aqua `#8CDFD8`. The colour is the Bot's body and nothing else; no text, line or panel takes it, and none of the six is a green. On white a Bot has a thin black edge, on black it is a solid shape, and a Bot that is not connected is grey. The six tokens sit in the last block of `public/css/app.css`.

- **Layout:** the signed-in pages are a stack of bands that run edge to edge, one thing per band, in the way large product sites are laid out. Each page opens with one large line (on the Brief, "Priya, 1 deadline needs you now."). Below it, each band has its title on the left and its content on the right, in a centred column up to 1320 px wide; under 900 px the title sits above the content. Most bands are white with a hairline between them; a few are grey; the Bots sit on a black band, where the same colour tokens are turned over so everything inside follows.
- **The demo's person picker:** a quiet button in the bar ("Viewing Priya Sharma, F-1 on OPT") that opens a short list drawn like the rest of the page: white, one black line, the current person ticked. It is built rather than a native select so the open list matches, and it works from the keyboard (arrows, Enter, Escape).
- **Navigation:** three places in a top bar (a bottom bar on a phone), each with its own address, plus Help. The mark under the current place travels when you change page, and a thin line along the top of the bar shows how far down the page you are. Every page ends with a footer of grouped links (Your visa, Your Bots, Help). The page before sign-in has its own bar: Sign in, and a "Show me the demo" button.
- **The Brief:** a headline that says how many deadlines need you, one button for the next step, then deadlines grouped as Act now, Watch and Clear. The day count is the largest thing in each row. Clear deadlines stay one line each, with the rest behind Details.
- **Risk:** a shape and a word, never a colour: solid square for Act now, outlined triangle for Watch, outlined circle for Clear.
- **First visit:** a three-step guide at the top of the Brief. Each step links to the real thing on the page and is marked done once you have used it. "Hide guide" puts it away for good (remembered in the browser); Help brings it back.
- **Logo:** stops along a path, each a little larger, ending at a target: deadlines on the way to a goal (`public/logo.svg`). Beside it the name is set lowercase in Unbounded, a wide rounded face whose letters echo the dots. It is the one place a second typeface is used, and only the letters of the name are loaded.
- **Bots:** six characters, one per Bot. Each is one solid shape that says its job (a page, a monitor, an owl, an envelope, a stopwatch, a speech bubble) with two eyes cut out of it, in the spirit of the blob characters in the Grok Bot app. They are in `public/js/bots.js`. The shapes are drawn for Waypoint; they are not xAI's artwork.
- **Bot states:** each Bot shows what it is doing in how it moves, after the states Grok Bot uses: asleep (not connected) is grey and breathes with its eyes shut, idle floats, blinks and glances, thinking tilts and looks up, working bounces inside a turning ring, waiting for you pulses with a dot, blocked shakes once and slumps, done hops and squashes as it lands. They appear on the Brief, in the logs, on the approval card, in Activity, in setup and on the Connect page.
- **Motion:** one idea runs through it: lines draw themselves, the way the logo is a path of stops that ends at a target.
  - *The page before sign-in* is the authored moment. Scrolling moves a clock through one night. A panel stays beside the steps and shows the Bot on duty at work, the packet moving along the wire to it, and a small Brief filling in row by row. At 8:00 AM the drafted email is stamped "Approved by you". The route line down the steps fills as you go. On a phone the panel rides under the bar with the clock, the Bots and the newest row.
  - *The Brief*, the first time it opens: each group's rule draws from the left and its rows rise in as they scroll into view, with the day count running up to its number. Later redraws change in place. Check now sends the packet along the wire to each Bot as it works. Approving an email stamps "Approved".
  - *Each signed-in page* opens with one large Bot beside its title, showing what is going on: on the Brief, Deadline Keeper pulses slowly when an email needs your answer, thinks when a deadline is close, and works while Check now runs; on Activity it is the Bot working now or the one that reported last. Each band's title and content rise in as the band scrolls into view. When the row of Bots scrolls into view they greet you: each hops in turn as the packet runs down the wire. A line a Bot has just added to the log drops in and settles.
  - *Small touches:* a Bot hops when you point at it (in the row, in a log line, in the opening), the logo plays again when you point at the wordmark (the stops appear in order and the target draws), the other places underline as you point at them, the Act now square taps now and then, and a ticked box pops.
  - *Everywhere:* the Bots' eyes follow the pointer, buttons answer a press, anything that opens unfolds, setup steps slide in, pages cross-fade, and the logo plays once on the page before sign-in.
  - Scroll motion uses IntersectionObserver and CSS scroll timelines, and animates only transform, opacity and clip-path. Nothing is hidden unless the script that reveals it is running. Under reduced motion the reveals, slides and loops are off and states change at once.
- **Boxes:** the only bordered boxes are an approval card and the panel in the night story. Bands are separated by space and a hairline, not boxes.

Tokens are at the top of `public/css/app.css`.

The pages are checked with the [Impeccable](https://github.com/pbakaus/impeccable) detector. With the server running:

```bash
npx impeccable detect http://localhost:4173/ http://localhost:4173/activity/ http://localhost:4173/settings/
```

Add `--viewport 390x844` for the phone pass.
