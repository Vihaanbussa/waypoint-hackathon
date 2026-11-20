// The Bot connector (MCP). What a Grok Bot sees when Waypoint is added as a custom
// connector. Every tool works only on the people the Bot's key speaks for.

import { createMcp } from './mcp.js';
import { maskNumber, toE164 } from './sms.js';
import { TEXT_KINDS, composeText } from './text-kinds.js';
import { BOTS, botName } from './config.js';
import { readBody, sendJson } from './http.js';
import { strictDay, publicHttpsUrl, xPostUrl, textDuringQuietHours } from './validate.js';
import { ABOUT_FIELDS, VISA_TYPES } from '../public/js/rules.js';
import { buildClocks } from '../public/js/clocks.js';
import { applicationDraft, assertProgress, putBankFact } from '../public/js/applications.js';
import { rankSchools, schoolSlug, scoreSchool } from '../public/js/schools.js';


const str = (description, extra = {}) => ({ type: 'string', description, ...extra });
const schema = (properties, required = []) => ({ type: 'object', properties, required, additionalProperties: false });
const PERSON = str('The person id, from list_people. Optional when the key speaks for one person.');

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

// Drop known secrets from anything a Bot is about to read. Short strings are
// left alone so an ordinary word is not mistaken for a key.
export function redactSecrets(value, secrets) {
  const needles = [...new Set((secrets || []).filter((item) => typeof item === 'string' && item.length >= 8))];
  const hidden = /^(key|password|secret|token|bot_key|authorization|hash|salt|private_key|api_key|auth_token)$/i;
  const walk = (item) => {
    if (typeof item === 'string') {
      let text = item;
      for (const secret of needles) if (text.includes(secret)) text = text.replaceAll(secret, '[redacted]');
      return text;
    }
    if (Array.isArray(item)) return item.map(walk);
    if (item && typeof item === 'object') {
      const out = {};
      for (const [key, inner] of Object.entries(item)) {
        if (hidden.test(key)) continue;
        out[key] = walk(inner);
      }
      return out;
    }
    return item;
  };
  return walk(value);
}

export function createBotTools({ store, appendRow, save, nowIso, localDay, publicUrlFromConfig, sendText, botScope, secretValues = () => [] }) {
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
  function schoolBrief(profile) {
    const schools = Array.isArray(profile.schools) ? profile.schools : [];
    const signals = (store.school_signals || []).filter((row) => row && row.person === profile.id);
    const enrolled = schools.find((school) => school.status === 'enrolled') || null;
    return {
      tracking: profile.track_schools !== false,
      targets: rankSchools(schools, signals),
      enrolled: enrolled
        ? { id: enrolled.id, name: enrolled.name, state: enrolled.state || '', ...scoreSchool(signals.filter((row) => row.school_id === enrolled.id)) }
        : null,
      alerts: (store.school_alerts || [])
        .filter((row) => row && row.person === profile.id)
        .map((row) => ({
          alert_id: row.id,
          school_id: row.school_id,
          school_name: row.school_name || '',
          title: row.title,
          why: row.why,
          risk: row.risk || 'watch',
          source_label: row.source_label || '',
          source_url: row.source_url || '',
          date: row.date || null,
        })),
    };
  }

  async function writtenText(profile, args, asOf = null) {
    const kind = String(args.kind || '');
    if (!Object.hasOwn(TEXT_KINDS, kind)) throw new Error(`"kind" must be one of: ${Object.keys(TEXT_KINDS).join(', ')}.`);
    const today = asOf || localDay(new Date(), profile.timezone);
    if (kind === 'school_alert') {
      const id = String(args.alert_id || args.deadline_id || '').trim();
      const alert = (store.school_alerts || []).find((row) => row && row.person === profile.id && row.id === id);
      if (!alert) throw new Error(`No school alert "${id.slice(0, 60)}". Use an alert_id from get_brief.`);
      const text = composeText(kind, { alert, today, link: (await siteLinks()).brief || '' });
      return { text, kind, deadline_id: alert.id, template: TEXT_KINDS[kind].trial };
    }
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

  // What a demo button texts about: the sample person's own most fitting deadline.
  const DEMO_TEXT_LABELS = {
    act_now: 'deadline to act on',
    reminder: 'deadline coming up',
    rule_change: 'rule change',
    status_change: 'case status',
    approval: 'email waiting',
    problem: 'failed check',
    school_alert: 'school notice',
  };

  function demoTextArgs(profile, kind, asOf = null) {
    const clocks = buildClocks(profile, store, asOf || localDay(new Date(), profile.timezone));
    const pick = (test) => clocks.find(test)?.id;
    const dated = (clock) => clock.kind !== 'alert' && clock.daysLeft != null;
    if (kind === 'act_now') return { kind, deadline_id: pick((clock) => dated(clock) && clock.risk === 'act') ?? pick(dated) };
    if (kind === 'reminder') return { kind, deadline_id: pick((clock) => dated(clock) && clock.risk === 'watch') ?? pick((clock) => dated(clock) && clock.risk !== 'act') };
    if (kind === 'rule_change') return { kind, deadline_id: pick((clock) => clock.kind === 'alert') };
    if (kind === 'status_change') return { kind, deadline_id: pick((clock) => String(clock.id).startsWith('notice-')) };
    if (kind === 'school_alert') return { kind, alert_id: (store.school_alerts || []).find((row) => row && row.person === profile.id)?.id };
    if (kind === 'problem') return { kind, bot: 'Case Clerk' };
    return { kind };
  }

  // `asOf` is the day the page is showing, so the text and the Brief agree.
  async function sendDemoText(profile, kind, asOf = null) {
    if (!Object.hasOwn(TEXT_KINDS, kind)) throw new Error('Pick one of the kinds of text.');
    const args = demoTextArgs(profile, kind, asOf);
    if (TEXT_KINDS[kind].needs === 'deadline' && !args.deadline_id) {
      throw new Error(`${profile.name.split(' ')[0]} has no ${DEMO_TEXT_LABELS[kind]} to text about right now.`);
    }
    if (TEXT_KINDS[kind].needs === 'alert' && !args.alert_id) {
      throw new Error(`${profile.name.split(' ')[0]} has no ${DEMO_TEXT_LABELS[kind]} to text about right now.`);
    }
    const made = await writtenText(profile, args, asOf);
    return sendText(profile, made.text, { ...made, demo: true });
  }

  const BOT_TOOLS = [
    {
      name: 'list_people',
      description:
        'Who this key can act for: each person\'s id, name, visa type, school, degree, field of study and home country (when they gave them), the schools they are tracking, case receipt numbers and how they want to be told, plus the current links to Waypoint\'s pages. Call this first.',
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
            ...Object.fromEntries(ABOUT_FIELDS.filter((field) => p[field.id]).map((field) => [field.id, p[field.id]])),
            receipts: p.receipts ?? [],
            phone: toE164(p.phone) ? maskNumber(toE164(p.phone)) : '',
            channels: p.channels ?? {},
            quiet_hours: p.quiet_hours ?? null,
            stage: p.stage === 'applying' ? 'applying' : 'enrolled',
            schools: p.schools ?? [],
            track_schools: p.track_schools !== false,
          })),
      }),
    },
    {
      name: 'get_brief',
      description:
        'The person\'s deadlines as Waypoint counts them (days left and risk are computed by code, never by a Bot), their school ranking and school alerts (scores are computed by code, never by a Bot), plus drafted emails waiting for the person. Read this before drafting or notifying.',
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
          schools: schoolBrief(profile),
          applications: (profile.schools || []).filter((school) => school.status === 'target').map((school) => ({
            school_id: school.id,
            name: school.name,
            status: school.application || 'not_started',
            missing: applicationDraft(profile.bank).missing,
          })),
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
        const row = appendRow(
          'runs',
          { person: profile.id, bot: args.bot, status: args.status, summary: args.summary, x_searches: args.x_searches, x_posts_read: args.x_posts_read },
          scope,
        );
        await save();
        return { saved: row.id };
      },
    },
    {
      name: 'save_case_status',
      description: 'Case Clerk: record what a case-status portal shows for one receipt number already on this person\'s profile. If the portal gives a date to respond by, pass it and Waypoint adds the deadline.',
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
      description: 'Scout: record a rule change that matters to this person. source_url must be the official https page. An X post alone is refused. If you first saw it on X, also pass that post as x_url.',
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
      name: 'list_applications',
      description: 'Each school this person is applying to, and whether Waypoint may still fill it. already_started, needs_review and submitted must be left alone. Read only.',
      inputSchema: schema({ person: PERSON }),
      run: (args, { scope }) => {
        const profile = personFor(args, scope);
        const draft = applicationDraft(profile.bank);
        return {
          stage: profile.stage === 'applying' ? 'applying' : 'enrolled',
          missing: draft.missing,
          applications: (profile.schools || []).map((school) => ({
            school_id: school.id,
            name: school.name,
            school_status: school.status,
            status: school.application || 'not_started',
            writable: ['not_started', 'draft_ready'].includes(school.application || 'not_started'),
          })),
        };
      },
    },
    {
      name: 'get_application_bank',
      description: 'Confirmed facts only, already mapped onto the form. Missing required facts are names, not guesses. Do not invent a value for a missing fact.',
      inputSchema: schema({ person: PERSON }),
      run: (args, { scope }) => {
        const profile = personFor(args, scope);
        const draft = applicationDraft(profile.bank);
        return {
          fields: draft.fields.filter((field) => field.confirmed).map(({ form, label, value, source }) => ({ form, label, value, source })),
          missing: draft.missing,
        };
      },
    },
    {
      name: 'save_bank_fact',
      description: 'Record one fact found in a document or an email. source is required. The fact stays unconfirmed until the student reviews it. A confirmed fact cannot be replaced.',
      inputSchema: schema(
        {
          person: PERSON,
          field: str('Which fact.', { enum: ['name', 'citizenship', 'degree', 'term', 'email', 'address', 'education', 'tests'] }),
          value: str('The value you found. Do not guess.'),
          source: str('Where you found it.', { enum: ['document', 'email'] }),
        },
        ['field', 'value', 'source'],
      ),
      run: async (args, { scope }) => {
        const profile = personFor(args, scope);
        profile.bank = putBankFact(profile.bank, { field: args.field, value: args.value, source: args.source }, { by: 'bot' });
        await save();
        return { saved: args.field, confirmed: false };
      },
    },
    {
      name: 'save_application_progress',
      description: 'Record that a school application was already started, or that a draft was filled from confirmed facts. Cannot mark it submitted, and cannot write over an application that already has progress.',
      inputSchema: schema(
        {
          person: PERSON,
          school_id: str('The school id from list_schools or list_applications.'),
          school_name: str('The school name, if you do not have the id.'),
          status: str('already_started if they have progress. draft_ready only when you filled a draft from confirmed facts and there was no progress yet.', { enum: ['already_started', 'draft_ready'] }),
        },
        ['status'],
      ),
      run: async (args, { scope }) => {
        const profile = personFor(args, scope);
        const id = schoolSlug(args.school_id || args.school_name || '');
        const school = (profile.schools || []).find((item) => item.id === id);
        if (!school) throw new Error('That school is not on this person\'s list. Add it in Waypoint first.');
        const next = assertProgress(school.application, String(args.status || ''), { by: 'bot' });
        if (next === 'draft_ready') {
          const missing = applicationDraft(profile.bank).missing;
          if (missing.length) throw new Error(`These facts are not confirmed yet: ${missing.join(', ')}.`);
        }
        school.application = next;
        await save();
        return { school_id: school.id, status: school.application };
      },
    },
    {
      name: 'list_schools',
      description: 'The schools this person is tracking, and whether school tracking is on. Call this before researching a school.',
      inputSchema: schema({ person: PERSON }),
      run: (args, { scope }) => {
        const profile = personFor(args, scope);
        return { tracking: profile.track_schools !== false, schools: profile.schools ?? [] };
      },
    },
    {
      name: 'get_school_ranking',
      description: 'How this person\'s target schools rank by international-student support. Waypoint computes every score from saved signals. Read only: do not pass or invent a score.',
      inputSchema: schema({ person: PERSON }),
      run: (args, { scope }) => {
        const profile = personFor(args, scope);
        const brief = schoolBrief(profile);
        return { tracking: brief.tracking, targets: brief.targets, enrolled: brief.enrolled };
      },
    },
    {
      name: 'save_school_signal',
      description: 'Scout: record one raw signal about a school already on this person\'s list. Pass the signal type and the value you found, with the official https page. Do not pass a score.',
      inputSchema: schema(
        {
          person: PERSON,
          school_id: str('The school id from list_schools.'),
          school_name: str('The school name, if you do not have the id.'),
          signal: str('Which signal this is.', { enum: ['intl_pct', 'advisor_ratio', 'isss_office', 'cpt_opt', 'emergency_fund', 'sentiment', 'state_policy', 'processing_days'] }),
          value: { description: 'The value you found. A number, true or false, or supportive, neutral, or restrictive. Not a score.' },
          source_label: str('Who published it, like the school\'s international office.'),
          source_url: str('Link to the official https page. A post on X is not enough.'),
        },
        ['signal', 'source_url'],
      ),
      run: async (args, { scope }) => {
        const profile = personFor(args, scope);
        const row = appendRow(
          'school_signals',
          {
            person: profile.id,
            school_id: args.school_id || '',
            school_name: args.school_name || '',
            signal: args.signal,
            value: args.value,
            source_label: args.source_label || '',
            source_url: args.source_url || '',
          },
          scope,
        );
        await save();
        return { saved: row.id, school_id: row.school_id, signal: row.signal };
      },
    },
    {
      name: 'save_school_alert',
      description: 'Scout: record a notice about a school already on this person\'s list. Waypoint shows it on the Brief. source_url must be the official https page.',
      inputSchema: schema(
        {
          person: PERSON,
          school_id: str('The school id from list_schools.'),
          school_name: str('The school name, if you do not have the id.'),
          title: str('What changed, in a few words.'),
          why: str('Why it matters to this person, in plain language. Not legal advice.'),
          risk: str('How urgent it is for them.', { enum: ['act', 'watch', 'clear'] }),
          source_label: str('Who published it.'),
          source_url: str('Link to the official https page.'),
          date: str('A date the notice gives, YYYY-MM-DD, if there is one.'),
        },
        ['title', 'why', 'source_url'],
      ),
      run: async (args, { scope }) => {
        const profile = personFor(args, scope);
        const row = appendRow(
          'school_alerts',
          {
            person: profile.id,
            school_id: args.school_id || '',
            school_name: args.school_name || '',
            title: args.title,
            why: args.why,
            risk: args.risk,
            source_label: args.source_label || '',
            source_url: args.source_url || '',
            date: args.date || '',
          },
          scope,
        );
        await save();
        return { saved: row.id, alert_id: row.id };
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
      description: 'Messenger: after saving an APPROVED email as a Gmail draft, record the draft id. Waypoint will not mark the email sent. The person sends it.',
      inputSchema: schema(
        { email_id: str('From list_emails.'), gmail_draft_id: str('The Gmail draft id.'), sent: { type: 'boolean', description: 'True if the email was actually sent.' } },
        ['email_id'],
      ),
      run: async (args, { scope }) => {
        const action = store.actions.find((a) => a.id === String(args.email_id));
        if (!action || !scope.persons.has(action.person)) throw new Error('No email with that id for the people this key acts for.');
        if (action.state !== 'approved') throw new Error(`This email is "${action.state}". Only an approved email may be saved as a draft.`);
        if (args.sent === true) throw new Error('Waypoint does not send email. Save it as a Gmail draft and pass gmail_draft_id. The person sends it.');
        if (!String(args.gmail_draft_id || '').trim()) throw new Error('Pass gmail_draft_id, the id of the Gmail draft you saved.');
        action.gmail_draft_id = String(args.gmail_draft_id).slice(0, 200);
        await save();
        return emailView(action);
      },
    },
    {
      name: 'log_message',
      description: 'Messenger: record a message that went to the person themselves (a calendar event, or a chat when texting is off). One line, 300 characters at most, with no receipt numbers.',
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
      '. Pass deadline_id from get_brief for act_now, reminder and rule_change, and for status_change when the change added a deadline. Pass alert_id for school_alert. Waypoint records the text, so do not also call log_message for it, and it will not send the same news twice in a day. Only when no kind fits, pass "text" instead: one line, no receipt numbers. During quiet hours this waits unless a deadline is Act now. If this fails, the reason says what to do.',
    inputSchema: schema({
      person: PERSON,
      kind: str('What the text is about. Waypoint writes the wording.', { enum: Object.keys(TEXT_KINDS) }),
      deadline_id: str('The deadline the text is about, from get_brief.'),
      alert_id: str('For kind "school_alert": the alert_id from get_brief.'),
      bot: str('For kind "problem": which Bot could not finish.', { enum: BOTS }),
      text: str('Only when no kind fits: the text, in one line, 300 characters at most.'),
    }),
      run: async (args, { scope }) => {
        const profile = personFor(args, scope);
        textDuringQuietHours(profile, store);
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
      'Waypoint tracks one person\'s visa deadlines and, when they add schools, how those schools support international students. Bots bring it facts (a case status, a rule change, a date from an email, a school signal) and Waypoint\'s own code counts the days, sets the risk and scores the schools. Never do date math or scoring yourself. Never send anything to another person: draft it with draft_email and wait for the person to approve it in Waypoint. End every run with report_run. Waypoint is not legal advice.',
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
    const handled = await mcp.handle(message, { scope });
    const status = handled.status;
    const body = handled.body == null ? null : redactSecrets(handled.body, secretValues());
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

  return { serveMcp, logBot, sendDemoText };
}
