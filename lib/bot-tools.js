// The Bot connector (MCP). What a Grok Bot sees when Waypoint is added as a custom
// connector. Every tool works only on the people the Bot's key speaks for.

import { createMcp } from './mcp.js';
import { maskNumber } from './sms.js';
import { TEXT_KINDS, composeText } from './text-kinds.js';
import { BOTS, botName } from './config.js';
import { readBody, sendJson } from './http.js';
import { strictDay, publicHttpsUrl } from './validate.js';
import { VISA_TYPES } from '../public/js/rules.js';
import { buildClocks } from '../public/js/clocks.js';

const str = (description, extra = {}) => ({ type: 'string', description, ...extra });
const schema = (properties, required = []) => ({ type: 'object', properties, required, additionalProperties: false });
const PERSON = str('The person id, from list_people. Optional when the key speaks for one person.');

// A link counts as an X post only if it really is on X.
function xPostUrl(value) {
  try {
    const url = new URL(String(value || ''));
    const host = url.hostname.replace(/^(www|mobile)\./, '');
    return url.protocol === 'https:' && (host === 'x.com' || host === 'twitter.com') ? url.href : '';
  } catch {
    return '';
  }
}

// The searches a Bot says it ran on X: a short list of short strings, no repeats.
function xSearches(value) {
  const list = Array.isArray(value) ? value : typeof value === 'string' ? value.split(/[\n;]+/) : [];
  const seen = new Set();
  for (const item of list) {
    const text = String(item ?? '').replace(/\s+/g, ' ').trim().slice(0, 100);
    if (text) seen.add(text);
  }
  return [...seen].slice(0, 8);
}

const emailView = (a) => ({
  email_id: a.id,
  state: a.state,
  deadline_id: a.clock ?? null,
  to: a.to ?? '',
  subject: a.subject ?? '',
  body: a.body ?? '',
  approved_at: a.state === 'approved' || a.state === 'sent' ? a.decided_at ?? null : null,
  gmail_draft_id: a.gmail_draft_id ?? null,
});

export function createBotTools({ store, appendRow, save, nowIso, localDay, publicUrlFromConfig, sendText, botScope }) {
  function personFor(args, scope) {
    const asked = String(args.person || '').trim();
    if (asked) {
      if (!scope.persons.has(asked)) throw new Error(`This key cannot act for person "${asked.slice(0, 40)}". Call list_people to see who it can act for.`);
      return store.profiles.find((p) => p.id === asked);
    }
    if (scope.persons.size === 1) return store.profiles.find((p) => p.id === [...scope.persons][0]);
    throw new Error(scope.persons.size ? 'Say which person: pass "person" with an id from list_people.' : 'This account has not added its details yet, so there is no one to act for.');
  }

  async function siteLinks() {
    const origin = (publicHttpsUrl(process.env.WAYPOINT_PUBLIC_URL || (await publicUrlFromConfig()) || '') || '').replace(/\/+$/, '');
    if (!origin) return { note: 'Waypoint has no public address set, so its pages cannot be opened from outside.' };
    return { brief: `${origin}/`, mock_case_portal: `${origin}/portal/`, edit_details: `${origin}/setup/?edit=1` };
  }

  // The words of a text of a given kind, written here from Waypoint's own facts:
  // the deadline as counted today, the latest case status, the emails waiting.
  async function writtenText(profile, args) {
    const kind = String(args.kind || '');
    if (!Object.hasOwn(TEXT_KINDS, kind)) throw new Error(`"kind" must be one of: ${Object.keys(TEXT_KINDS).join(', ')}.`);
    const today = localDay(new Date(), profile.timezone);
    const clocks = buildClocks(profile, store, today);
    const wanted = String(args.deadline_id || '').trim();
    const clock = wanted ? clocks.find((c) => c.id === wanted) : null;
    if (wanted && !clock) throw new Error(`${profile.name} has no deadline "${wanted.slice(0, 60)}". Use a deadline_id from get_brief.`);
    const waiting = store.actions.filter((a) => a && a.person === profile.id && (!a.state || a.state === 'drafted'));
    const caseRow = store.case_status.filter((r) => r && r.person === profile.id).sort((a, b) => String(a.checked_at ?? a.at).localeCompare(String(b.checked_at ?? b.at))).at(-1) ?? null;
    const bot = args.bot ? botName(args.bot) : '';
    if (bot && !BOTS.includes(bot)) throw new Error(`"bot" must be one of: ${BOTS.join(', ')}.`);
    const text = composeText(kind, {
      clock,
      today,
      link: (await siteLinks()).brief || '',
      waiting: waiting.length,
      draftWaiting: Boolean(clock) && waiting.some((a) => a.clock === clock.id),
      caseRow,
      bot,
    });
    return { text, kind, deadline_id: clock?.id ?? '', template: TEXT_KINDS[kind].trial };
  }

  const BOT_TOOLS = [
    {
      name: 'list_people',
      description:
        'Who this key can act for: each person\'s id, name, visa type, case receipt numbers and how they want to be told, plus the current links to Waypoint\'s pages. Call this first.',
      inputSchema: schema({}),
      run: async (args, { scope }) => ({
        // Where Waypoint's pages are right now. The address can change, so use these
        // links rather than one remembered from an earlier run.
        links: await siteLinks(),
        people: store.profiles
          .filter((p) => scope.persons.has(p.id))
          .map((p) => ({
            person: p.id,
            name: p.name,
            visa_type: VISA_TYPES[p.visa_type]?.label ?? p.visa_type,
            receipts: p.receipts ?? [],
            phone: p.phone ?? '',
            channels: p.channels ?? {},
            quiet_hours: p.quiet_hours ?? null,
          })),
      }),
    },
    {
      name: 'get_brief',
      description:
        'The person\'s deadlines as Waypoint counts them (days left and risk are computed by code, never by a Bot), plus drafted emails waiting for the person. Read this before drafting or notifying.',
      inputSchema: schema({ person: PERSON, today: str('Optional date to count from, YYYY-MM-DD. Defaults to today.') }),
      run: (args, { scope }) => {
        const profile = personFor(args, scope);
        const today = strictDay(args.today) || localDay(new Date(), profile.timezone);
        return {
          person: profile.id,
          today,
          deadlines: buildClocks(profile, store, today).map((c) => ({
            deadline_id: c.id,
            name: c.name,
            due: c.due ?? null,
            days_left: c.daysLeft ?? null,
            risk: c.risk,
            reason: c.reason,
          })),
          emails_waiting_for_approval: store.actions.filter((a) => a.person === profile.id && a.state === 'drafted').map(emailView),
        };
      },
    },
    {
      name: 'report_run',
      description: 'Record that a Bot ran, in one line the person will read. Call it at the end of every run, including failed ones.',
      inputSchema: schema(
        {
          person: PERSON,
          bot: str('Which Bot ran.', { enum: BOTS }),
          status: str('How it went.', { enum: ['ok', 'failed', 'running'] }),
          summary: str('One plain line, for example: Read status: "Case Was Received".'),
          x_searches: {
            type: 'array',
            items: { type: 'string' },
            description: 'Scout only, and required when its run went ok: the searches you ran on X this run, exactly as you typed them.',
          },
          x_posts_read: { type: 'integer', description: 'Scout only: how many X posts you read this run.' },
        },
        ['bot', 'summary'],
      ),
      run: async (args, { scope }) => {
        const profile = personFor(args, scope);
        const bot = botName(args.bot);
        if (!BOTS.includes(bot)) throw new Error(`"bot" must be one of: ${BOTS.join(', ')}.`);
        if (!String(args.summary || '').trim()) throw new Error('Add a one-line summary.');
        const status = ['failed', 'running'].includes(args.status) ? args.status : 'ok';
        // Scout's job includes watching X, so a run that went ok has to say what it
        // searched there. Otherwise "No relevant changes" could mean it never looked.
        // (A Bot still reporting as the old Inbox Scout never searched X, so it is let be.)
        const watcher = ['Scout', 'Policy Watcher'].includes(String(args.bot));
        const searches = watcher ? xSearches(args.x_searches) : [];
        if (watcher && status === 'ok' && !searches.length) {
          throw new Error(
            'Scout has to search X before it reports. Run your X searches for this person\'s visa type, then call report_run again with x_searches (the searches you ran) and x_posts_read (how many posts you read). If you cannot search X right now, report status "failed" and say so in the summary.',
          );
        }
        const onX = searches.length ? { x_searches: searches, x_posts_read: Math.max(0, Math.min(9999, Math.floor(Number(args.x_posts_read)) || 0)) } : {};
        const row = appendRow('runs', { person: profile.id, bot, status, summary: String(args.summary), ...onX }, scope);
        await save();
        return { saved: row.id };
      },
    },
    {
      name: 'save_case_status',
      description: 'Case Clerk: record what a case-status portal shows for one receipt number. If the portal gives a date to respond by, pass it and Waypoint adds the deadline.',
      inputSchema: schema(
        {
          person: PERSON,
          receipt: str('The receipt number, like IOE0912345678.'),
          title: str('A short name for the case, like "STEM OPT case".'),
          portal: str('Where it was read, like "USCIS Case Status Online".'),
          status: str('The status exactly as the portal words it.'),
          last_changed: str('Date the status last changed, YYYY-MM-DD, if shown.'),
          response_due: str('Date a response is due, YYYY-MM-DD, if the portal or notice gives one.'),
        },
        ['receipt', 'status'],
      ),
      run: async (args, { scope }) => {
        const profile = personFor(args, scope);
        if (!String(args.status || '').trim()) throw new Error('Pass the status as the portal words it.');
        for (const field of ['last_changed', 'response_due']) {
          if (args[field] && !strictDay(args[field])) throw new Error(`"${field}" must be a real date like 2027-02-10.`);
        }
        const row = appendRow(
          'case_status',
          {
            person: profile.id,
            receipt: String(args.receipt || '').toUpperCase(),
            title: args.title || 'Case',
            portal: args.portal || 'Case status portal',
            status: String(args.status),
            last_changed: args.last_changed || null,
            response_due: args.response_due || null,
          },
          scope,
        );
        await save();
        return { saved: row.id };
      },
    },
    {
      name: 'save_policy_alert',
      description: 'Scout: record a rule change or official notice that matters to this person, with why it matters to them and a link to the official source. If you first saw it on X, say so with x_url.',
      inputSchema: schema(
        {
          person: PERSON,
          title: str('What changed, in a few words.'),
          why: str('Why it matters to this person, in plain language. Not legal advice.'),
          risk: str('How urgent it is for them.', { enum: ['act', 'watch', 'clear'] }),
          source_label: str('Who published it, like "USCIS" or "Federal Register".'),
          source_url: str('Link to the official page.'),
          x_url: str('If you first saw this on X: the link to that post (https://x.com/...). A post alone is not enough; the official source is still needed.'),
          seen_on_x: { type: 'boolean', description: 'True if you first saw this on X but have no single post to link.' },
        },
        ['title', 'why'],
      ),
      run: async (args, { scope }) => {
        const profile = personFor(args, scope);
        if (!String(args.title || '').trim() || !String(args.why || '').trim()) throw new Error('A title and a "why" are both needed.');
        const row = appendRow(
          'alerts',
          {
            person: profile.id,
            title: String(args.title),
            why: String(args.why),
            risk: ['act', 'watch', 'clear'].includes(args.risk) ? args.risk : 'clear',
            source_label: args.source_label || '',
            source_url: args.source_url || '',
            x_url: xPostUrl(args.x_url),
            seen_on_x: Boolean(xPostUrl(args.x_url)) || args.seen_on_x === true,
          },
          scope,
        );
        await save();
        return { saved: row.id };
      },
    },
    {
      name: 'save_inbox_date',
      description: 'Scout: record a dated item found in the person\'s email (an appointment, a response deadline). Waypoint turns it into a deadline. Never pass ID numbers or the email\'s full text.',
      inputSchema: schema(
        {
          person: PERSON,
          label: str('What the date is, like "Biometrics appointment".'),
          due_date: str('The date, YYYY-MM-DD.'),
          sender: str('Who sent the email, like "USCIS".'),
          subject: str('The email\'s subject line.'),
        },
        ['label', 'due_date'],
      ),
      run: async (args, { scope }) => {
        const profile = personFor(args, scope);
        if (!strictDay(args.due_date)) throw new Error('"due_date" must be a real date like 2026-12-09.');
        const row = appendRow(
          'inbox_facts',
          { person: profile.id, label: String(args.label || 'Date from your inbox'), due_date: args.due_date, sender: args.sender || '', subject: args.subject || '' },
          scope,
        );
        await save();
        return { saved: row.id };
      },
    },
    {
      name: 'set_deadline_note',
      description: 'Manager: replace the default one-line reason under a deadline with wording that fits this person. Do not restate day counts; Waypoint shows those.',
      inputSchema: schema({ person: PERSON, deadline_id: str('From get_brief.'), reason: str('One or two plain sentences.') }, ['deadline_id', 'reason']),
      run: async (args, { scope }) => {
        const profile = personFor(args, scope);
        if (!String(args.reason || '').trim()) throw new Error('Add the reason text.');
        const row = appendRow('clock_notes', { person: profile.id, clock: String(args.deadline_id), reason: String(args.reason) }, scope);
        await save();
        return { saved: row.id };
      },
    },
    {
      name: 'draft_email',
      description:
        'Manager: draft an email from the person to someone else (HR, a school official, an attorney). It is only a draft: the person must approve it in Waypoint before anything is sent. Never send it yourself.',
      inputSchema: schema(
        {
          person: PERSON,
          deadline_id: str('The deadline this email helps with, from get_brief.'),
          recipient_label: str('Who it goes to, in words, like "HR at your employer".'),
          to: str('The recipient\'s email address.'),
          subject: str('Subject line.'),
          body: str('The email, written as the person, plain and short.'),
        },
        ['recipient_label', 'subject', 'body'],
      ),
      run: async (args, { scope }) => {
        const profile = personFor(args, scope);
        if (!String(args.body || '').trim()) throw new Error('The email needs a body.');
        const row = appendRow(
          'actions',
          {
            person: profile.id,
            clock: args.deadline_id || '',
            recipient_label: String(args.recipient_label || 'someone else'),
            to: args.to || '',
            subject: String(args.subject || ''),
            body: String(args.body),
            drafted_by: 'Manager',
          },
          scope,
        );
        await save();
        return { email_id: row.id, state: row.state, next: 'Wait. The person approves or rejects it in Waypoint.' };
      },
    },
    {
      name: 'workflow_status',
      description:
        'Manager: where this run stands. Each Bot\'s latest run (who has reported and when, who failed), how many drafted emails are waiting for the person\'s approval, and which approved emails are not in their Gmail yet. Call it after starting the workers and before handing off to Messenger.',
      inputSchema: schema({ person: PERSON }),
      run: (args, { scope }) => {
        const profile = personFor(args, scope);
        const latest = new Map();
        for (const run of store.runs) {
          if (!run || run.person !== profile.id) continue;
          const prev = latest.get(run.bot);
          if (!prev || String(run.at) >= String(prev.at)) latest.set(run.bot, run);
        }
        const emails = store.actions.filter((a) => a && a.person === profile.id);
        return {
          now: nowIso(),
          bots: BOTS.map((name) => {
            const run = latest.get(name);
            return run
              ? { bot: name, status: run.status || 'ok', at: run.at, summary: run.summary ?? '', simulated: run.simulated === true, sample: run.sample === true }
              : { bot: name, status: 'no run yet' };
          }),
          emails_waiting_for_approval: emails.filter((a) => !a.state || a.state === 'drafted').length,
          approved_emails_not_delivered: emails.filter((a) => a.state === 'approved' && !a.gmail_draft_id).map((a) => a.id),
        };
      },
    },
    {
      name: 'list_emails',
      description: 'Manager and Messenger: the person\'s drafted emails and what they decided. Only an email whose state is "approved" may be put in their Gmail.',
      inputSchema: schema({ person: PERSON, state: str('Only this state.', { enum: ['drafted', 'approved', 'rejected', 'sent'] }) }),
      run: (args, { scope }) => {
        const profile = personFor(args, scope);
        return { emails: store.actions.filter((a) => a.person === profile.id && (!args.state || a.state === args.state)).map(emailView) };
      },
    },
    {
      name: 'mark_email_delivered',
      description: 'Messenger: after putting an APPROVED email in the person\'s Gmail, record it. Pass the Gmail draft id if it was saved as a draft, or sent=true if it was sent.',
      inputSchema: schema(
        { email_id: str('From list_emails.'), gmail_draft_id: str('The Gmail draft id.'), sent: { type: 'boolean', description: 'True if the email was actually sent.' } },
        ['email_id'],
      ),
      run: async (args, { scope }) => {
        const action = store.actions.find((a) => a.id === String(args.email_id));
        if (!action || !scope.persons.has(action.person)) throw new Error('No email with that id for the people this key acts for.');
        if (!['approved', 'sent'].includes(action.state)) throw new Error(`This email is "${action.state}". Only an approved email may be delivered.`);
        if (args.gmail_draft_id) action.gmail_draft_id = String(args.gmail_draft_id).slice(0, 200);
        if (args.sent === true) action.state = 'sent';
        await save();
        return emailView(action);
      },
    },
    {
      name: 'log_message',
      description: 'Messenger: record a message that went to the person themselves (a text, a calendar event). No receipt numbers or ID numbers in the text.',
      inputSchema: schema(
        {
          person: PERSON,
          channel: str('How it was delivered. Use "chat" for a message sent to the person in Grok Bot.', { enum: ['sms', 'calendar', 'gmail', 'slack', 'chat'] }),
          text: str('What it said, in one line.'),
          state: str('What happened.', { enum: ['sent', 'synced', 'held', 'failed'] }),
        },
        ['channel', 'text'],
      ),
      run: async (args, { scope }) => {
        const profile = personFor(args, scope);
        const row = appendRow('notifications', { person: profile.id, channel: String(args.channel), text: String(args.text || ''), state: args.state || 'sent' }, scope);
        await save();
        return { saved: row.id };
      },
    },
    {
      name: 'send_text',
      description:
        'Messenger: send one text message to the person\'s own phone, through Waypoint. Pass "kind" and Waypoint writes the words itself, with the date and days left from its own counting: ' +
        Object.entries(TEXT_KINDS).map(([kind, k]) => `${kind} (${k.about})`).join('; ') +
        '. Pass deadline_id from get_brief for act_now, reminder and rule_change, and for status_change when the change added a deadline. Waypoint records the text, so do not also call log_message for it, and it will not send the same news twice in a day. Only when no kind fits, pass "text" instead: one line, no day counts of your own, no receipt numbers or ID numbers. If this fails, the reason says what to do.',
      inputSchema: schema({
        person: PERSON,
        kind: str('What the text is about. Waypoint writes the wording.', { enum: Object.keys(TEXT_KINDS) }),
        deadline_id: str('The deadline the text is about, from get_brief.'),
        bot: str('For kind "problem": which Bot could not finish.', { enum: BOTS }),
        text: str('Only when no kind fits: the text, in one line, 300 characters at most.'),
      }),
      run: async (args, { scope }) => {
        const profile = personFor(args, scope);
        if (!args.kind && !String(args.text || '').trim()) throw new Error('Pass "kind" (Waypoint writes the words), or "text" when no kind fits.');
        const made = args.kind ? await writtenText(profile, args) : { text: args.text };
        const { row, to, template } = await sendText(profile, made.text, made);
        return {
          sent: true,
          to: maskNumber(to),
          saved: row.id,
          text: row.text,
          ...(template
            ? { note: 'This Twilio account is on a trial, which only sends Twilio\'s own sample texts. The phone got a sample text, not this wording. The real line is recorded in Waypoint, so give the person that line in chat as well.' }
            : {}),
        };
      },
    },
  ];

  const mcp = createMcp({
    name: 'waypoint',
    version: '1.0.0',
    instructions:
      'Waypoint tracks one person\'s visa deadlines. Bots bring it facts (a case status, a rule change, a date from an email) and Waypoint\'s own code counts the days and sets the risk. Never do date math yourself. Never send anything to another person: draft it with draft_email and wait for the person to approve it in Waypoint. End every run with report_run. Waypoint is not legal advice.',
    tools: BOT_TOOLS,
  });

  // One line per connector call, so a failed connection can be diagnosed. Never the key.
  function logBot(req, status, what = '') {
    const agent = String(req.headers['user-agent'] || '-').slice(0, 60);
    const key = req.headers.authorization ? 'key sent' : 'no key';
    console.log(`[bot] ${new Date().toISOString().slice(11, 19)} ${req.method} ${req.url} -> ${status} ${what} (${key}; ${agent})`);
  }

  async function serveMcp(req, res) {
    if (req.method !== 'POST') {
      logBot(req, 405);
      res.setHeader('Allow', 'POST');
      return sendJson(res, 405, { jsonrpc: '2.0', id: null, error: { code: -32000, message: 'Send JSON-RPC by POST.' } });
    }
    const scope = botScope(req, null);
    if (!scope) {
      logBot(req, 401, req.headers.authorization ? 'key not recognised' : '');
      res.setHeader('WWW-Authenticate', 'Bearer realm="waypoint"');
      return sendJson(res, 401, { jsonrpc: '2.0', id: null, error: { code: -32001, message: 'Add the header "Authorization: Bearer <your Waypoint Bot key>". The key is in Waypoint, under Settings, Connect your Bots.' } });
    }
    let message;
    try {
      ({ data: message } = await readBody(req));
    } catch {
      return sendJson(res, 400, { jsonrpc: '2.0', id: null, error: { code: -32700, message: 'The body is not valid JSON.' } });
    }
    const { status, body } = await mcp.handle(message, { scope });
    const called = (Array.isArray(message) ? message : [message])
      .map((m) => (m?.method === 'tools/call' ? `tools/call ${m.params?.name}` : m?.method))
      .join(', ');
    logBot(req, status, String(called).slice(0, 120));
    if (body == null) {
      res.writeHead(status, { 'Cache-Control': 'no-store' });
      return res.end();
    }
    return sendJson(res, status, body);
  }

  return { serveMcp, logBot };
}
