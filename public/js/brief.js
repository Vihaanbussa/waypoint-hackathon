// The Brief: what needs the person now, deadlines grouped by urgency, the
// drafted action under the deadline it fixes, and what the Bots did.
// Approval happens in place. A first-visit guide points at the real page.

import { initPage, el, safeUrl, formatTime, riskMark, rowsOf, recall, remember, xChecked } from './common.js';
import { buildClocks, overall, formatDate, addDays, RISK_LABEL } from './clocks.js';
import { rankSchools, scoreSchool } from './schools.js';
import { APPLICATION_STATUS_LABEL, applicationDraft } from './applications.js';
import { updateAction, post } from './store.js';
import { BOTS, botRelay, playRelay, botAvatar, botByName, botName, setBotState, sendPacket, heroBot } from './bots.js';
import { arriveOnView, arriveBands } from './motion.js';

arriveBands();

const reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)');
const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const seen = new Map(); // profile id -> deadline ids shown when the page opened
const openDetails = new Set(); // deadline ids whose Details are open
let editing = null; // id of the action being edited
let showGuide = null; // set once the page has drawn
let current = null; // the latest page context, for forms that live outside the redraw

// The guide shows until the person hides it. Help brings it back.
// Remembered per account, so a second person on this browser gets their own first visit.
const GUIDE = 'waypoint.guide.v1';
let GUIDE_KEY = GUIDE;
const askedForGuide = new URLSearchParams(location.search).get('guide') === '1';
let guideOpen = true;
let guideFor = null;

const GROUPS = [
  { risk: 'act', hint: 'Do these first.' },
  { risk: 'watch', hint: 'Coming up. Keep an eye on these.' },
  { risk: 'clear', hint: 'On track. Nothing to do yet.' },
];

function calendarUrl(clock, profile) {
  const day = clock.due.replaceAll('-', '');
  const next = addDays(clock.due, 1).replaceAll('-', '');
  const back = `${location.origin}/?p=${encodeURIComponent(profile.id)}#stop-${clock.id}`;
  const params = new URLSearchParams({
    action: 'TEMPLATE',
    text: `Waypoint: ${clock.name}`,
    dates: `${day}/${next}`,
    details: `${clock.reason}\n\nOpen your brief: ${back}`,
  });
  return `https://calendar.google.com/calendar/render?${params}`;
}

function gmailUrl(action) {
  const params = new URLSearchParams({ view: 'cm', fs: '1', to: action.to || '', su: action.subject || '', body: action.body || '' });
  return `https://mail.google.com/mail/?${params}`;
}

// ---- the top of the page: what needs you, and the one next step ----

const plural = (n, one, many) => `${n} ${n === 1 ? one : many}`;

function renderLead(ctx, clocks, pending) {
  const { store, profile, today } = ctx;
  const { nextDays, overdue } = overall(clocks);
  const act = clocks.filter((c) => c.risk === 'act').length;
  const watch = clocks.filter((c) => c.risk === 'watch').length;
  const first = profile.name.split(' ')[0];

  let headline = `${first}, you're all clear.`;
  if (!clocks.length) headline = ctx.me.demo ? `${first} has no deadlines yet.` : `Welcome, ${first}. Add your dates to get started.`;
  else if (act) headline = `${first}, ${plural(act, 'deadline needs', 'deadlines need')} you now.`;
  else if (watch) headline = `${first}, nothing is urgent. ${plural(watch, 'deadline is', 'deadlines are')} coming up.`;
  document.getElementById('headline').textContent = headline;
  // The Manager fronts the page: waiting when it is holding an email for your
  // approval, thinking when a deadline is close, otherwise at ease.
  if (pending.length) heroBot('manager', 'waiting', 'is holding an email for your approval');
  else if (act) heroBot('manager', 'thinking', 'is watching a close deadline');
  else heroBot('manager', 'idle', 'has nothing for you right now');

  let next = clocks.length ? 'No dated deadlines.' : 'Waypoint counts the days once it has a date to count from.';
  if (overdue) next = `${plural(overdue, 'deadline is', 'deadlines are')} overdue.`;
  else if (nextDays === 0) next = 'The next deadline is today.';
  else if (nextDays != null) next = `The next deadline is in ${plural(nextDays, 'day', 'days')}.`;
  const runs = rowsOf(store.runs).filter((r) => r.person === profile.id && r.status === 'ok');
  const last = runs.map((r) => r.at).sort().at(-1);
  document.getElementById('lead-sub').textContent = `${next} ${last ? `Last checked ${formatTime(last, today)}.` : 'Not checked yet.'}`;

  const action = document.getElementById('lead-action');
  const skip = document.getElementById('skip-link');
  if (pending.length) {
    const label = pending.length === 1 ? 'Review the drafted email' : `Review ${pending.length} drafted emails`;
    action.replaceChildren(el('a', { class: 'btn btn--primary', href: `#approval-${pending[0].id}`, text: label }));
    action.hidden = false;
    skip.href = `#approval-${pending[0].id}`;
    skip.textContent = 'Skip to the email that needs your approval';
  } else {
    action.replaceChildren();
    action.hidden = true;
    skip.href = '#main';
    skip.textContent = 'Skip to content';
  }
}

// ---- first-visit guide ----

function renderGuide(ctx, clocks, actions, pending) {
  if (guideFor !== ctx.me.id) {
    guideFor = ctx.me.id;
    GUIDE_KEY = `${GUIDE}.${ctx.me.id}`;
    guideOpen = askedForGuide || recall(GUIDE_KEY) !== 'hidden';
  }
  const guide = document.getElementById('guide');
  guide.hidden = !guideOpen;
  if (!guideOpen) {
    guide.replaceChildren();
    return;
  }
  const redraw = () => renderGuide(ctx, clocks, actions, pending);
  const step = (done, title, text, link) =>
    el(
      'li',
      { class: done ? 'is-done' : null },
      el('span', { class: 'guide-step-title', text: title }),
      text,
      el('br'),
      link,
      done ? el('span', { class: 'guide-done', text: 'Done' }) : null,
    );

  const top = clocks[0];
  const readLink = top
    ? el('a', {
        class: 'guide-step-go',
        href: `#stop-${top.id}`,
        text: 'Show me',
        onclick: () => {
          remember(`${GUIDE_KEY}.read`, '1');
          redraw();
        },
      })
    : null;

  const answered = actions.some((a) => a.state && a.state !== 'drafted');
  const draft = pending[0] || actions[0];
  const draftLink = draft
    ? el('a', { class: 'guide-step-go', href: `#approval-${draft.id}`, text: 'Show me' })
    : el('span', { class: 'guide-step-go muted', text: 'None waiting right now.' });

  const hide = el('button', { class: 'btn btn--quiet', type: 'button', text: 'Hide guide', 'aria-label': 'Hide this guide' });
  hide.addEventListener('click', () => {
    guideOpen = false;
    remember(GUIDE_KEY, 'hidden');
    redraw();
    document.getElementById('help-link')?.focus();
  });

  guide.replaceChildren(
    el('div', { class: 'guide-head' }, el('h2', { id: 'guide-title', text: 'New here? Start with three steps.' }), hide),
    el('p', {
      class: 'guide-intro',
      text: 'Waypoint tracks your visa deadlines. Bots check for changes every night, so you only come here to see what needs you.',
    }),
    el(
      'ol',
      { class: 'guide-steps' },
      step(
        recall(`${GUIDE_KEY}.read`) === '1',
        'Read your top deadline',
        'Most urgent first. The big number is the days you have left.',
        readLink,
      ),
      step(
        answered,
        'Answer the drafted email',
        'A Bot writes it for you. Nothing is sent until you approve.',
        draftLink,
      ),
      step(
        recall(`${GUIDE_KEY}.settings`) === '1',
        'Choose how you are told',
        'By text, in your calendar, or by email.',
        el('a', { class: 'guide-step-go', href: `/settings/?p=${encodeURIComponent(ctx.profile.id)}`, text: 'Open Settings' }),
      ),
    ),
    el('p', {
      class: 'guide-foot',
      text: ctx.me.demo
        ? 'This demo has two sample people: Priya, a student on OPT, and Wei, a graduate on H-1B. Switch between them with Viewing, at the top. Help brings this guide back.'
        : 'These are your own details. Change them any time in Settings. Help brings this guide back.',
    }),
  );
}

// ---- approval card ----

function decidedLine(action, today) {
  const when = formatTime(action.decided_at, today);
  const id = `approval-${action.id}`;
  if (action.state === 'rejected') {
    return el('p', { class: 'decided', id, tabindex: '-1', text: `Rejected by you${when ? ` at ${when}` : ''}. Nothing was sent.` });
  }
  const line = el('p', { class: 'decided', id, tabindex: '-1' }, `Approved by you${when ? ` at ${when}` : ''}. `);
  if (action.state === 'sent') line.append('Sent from your Gmail.');
  else if (action.gmail_draft_id) line.append('Saved to Gmail Drafts.');
  else line.append(el('a', { href: gmailUrl(action), target: '_blank', rel: 'noopener', text: 'Open it in Gmail to send' }), '.');
  return line;
}

function approvalCard(action, ctx) {
  if (action.state && action.state !== 'drafted') return decidedLine(action, ctx.today);

  const titleId = `approval-title-${action.id}`;
  const card = el('article', { class: 'card', id: `approval-${action.id}`, tabindex: '-1', 'aria-labelledby': titleId });
  const error = el('p', { class: 'error', role: 'alert', hidden: true });
  const fail = (message) => {
    error.textContent = message;
    error.hidden = false;
  };
  card.append(
    el('h4', { id: titleId, text: `Drafted email to ${action.recipient_label || 'someone else'}` }),
    el(
      'dl',
      { class: 'mail-meta' },
      el('dt', { text: 'To' }),
      el('dd', { text: action.to || 'Not set' }),
      el('dt', { text: 'Subject' }),
      el('dd', { text: action.subject || 'No subject' }),
    ),
  );

  if (editing === action.id) {
    const areaId = `edit-${action.id}`;
    const area = el('textarea', { id: areaId, rows: '10' });
    area.value = action.body || '';
    const save = el('button', { class: 'btn btn--primary', type: 'button', text: 'Save' });
    const cancel = el('button', { class: 'btn', type: 'button', text: 'Cancel' });
    save.addEventListener('click', async () => {
      if (!area.value.trim()) return fail('The email cannot be empty.');
      save.disabled = true;
      try {
        await updateAction(action.id, { body: area.value });
        editing = null;
        ctx.setBusy(false);
        await ctx.refresh();
        document.getElementById(`approval-${action.id}`)?.focus();
      } catch (err) {
        save.disabled = false;
        fail(`Couldn't save your edit. ${err.message}`);
      }
    });
    cancel.addEventListener('click', async () => {
      editing = null;
      ctx.setBusy(false);
      await ctx.refresh();
      document.getElementById(`approval-${action.id}`)?.focus();
    });
    card.append(el('label', { for: areaId, text: 'Email text' }), area, error, el('div', { class: 'card-actions' }, save, cancel));
    return card;
  }

  const draftedAt = formatTime(action.at, ctx.today);
  const approve = el('button', { class: 'btn btn--primary', type: 'button', text: 'Approve' });
  const edit = el('button', { class: 'btn', type: 'button', text: 'Edit' });
  const reject = el('button', { class: 'btn', type: 'button', text: 'Reject' });
  const buttons = [approve, edit, reject];

  async function decide(state) {
    buttons.forEach((b) => (b.disabled = true));
    ctx.setBusy(true);
    try {
      if (state === 'approved') {
        card.append(el('p', { class: 'stamp', 'aria-hidden': 'true', text: 'Approved' }));
        // The stamp lands in 300 ms and holds for a beat before the card folds.
        await Promise.all([updateAction(action.id, { state }), wait(reducedMotion.matches ? 0 : 750)]);
      } else {
        await updateAction(action.id, { state });
      }
      ctx.setBusy(false);
      await ctx.refresh();
      document.getElementById(`approval-${action.id}`)?.focus();
    } catch (err) {
      ctx.setBusy(false);
      card.querySelector('.stamp')?.remove();
      buttons.forEach((b) => (b.disabled = false));
      fail(`Couldn't save your ${state === 'approved' ? 'approval' : 'answer'}. ${err.message}`);
    }
  }

  approve.addEventListener('click', () => decide('approved'));
  reject.addEventListener('click', () => decide('rejected'));
  edit.addEventListener('click', async () => {
    editing = action.id;
    ctx.setBusy(true);
    await ctx.refresh();
    document.getElementById(`edit-${action.id}`)?.focus();
  });

  card.append(
    el('p', { class: 'mail-body', text: action.body || '' }),
    el(
      'p',
      { class: 'card-note with-bot' },
      botAvatar('manager', { state: 'waiting', size: 20, detail: 'holding this for your approval' }),
      `Drafted by the ${botName(action.drafted_by || 'Manager')}${draftedAt ? ` at ${draftedAt}` : ''}, which holds it until you approve. Nothing is sent before that.`,
    ),
    error,
    el('div', { class: 'card-actions' }, ...buttons),
  );
  return card;
}

// ---- deadlines ----

// The left column: a number and its unit, or a word when there is no count.
function countCell(clock) {
  const n = clock.daysLeft;
  let num = null;
  let unit = '';
  if (clock.kind === 'counter') [num, unit] = [String(clock.count.left), clock.count.left === 1 ? 'day left' : 'days left'];
  else if (n == null) [num, unit] = [clock.kind === 'case' ? 'Case' : 'Notice', ''];
  else if (n < 0) [num, unit] = [String(-n), n === -1 ? 'day late' : 'days late'];
  else if (n === 0) [num, unit] = ['Today', ''];
  else if (n > 730) [num, unit] = [`${Math.floor(n / 365)}+`, 'years left'];
  else [num, unit] = [String(n), n === 1 ? 'day left' : 'days left'];
  const word = !/^\d/.test(num);
  return el(
    'p',
    { class: 'stop-count' },
    el('span', { class: `stop-num${word ? ' stop-num--word' : ''}`, text: num }),
    unit ? el('span', { class: 'stop-unit', text: unit }) : null,
  );
}

function stopLinks(clock, profile, ctx) {
  const links = [];
  const linkUrl = clock.link && safeUrl(clock.link.url);
  if (linkUrl) links.push(el('a', { href: linkUrl, target: '_blank', rel: 'noopener', text: clock.link.label }));
  if (clock.due && clock.kind === 'date') {
    links.push(el('a', { href: calendarUrl(clock, profile), target: '_blank', rel: 'noopener', text: 'Add to Google Calendar' }));
  }
  if (clock.seenOnX) {
    const postUrl = safeUrl(clock.seenOnX.url);
    links.push(
      postUrl
        ? el('a', { href: postUrl, target: '_blank', rel: 'noopener', text: 'First seen on X' })
        : el('span', { text: 'First seen on X' }),
    );
  }
  if (clock.source?.label) {
    const sourceUrl = safeUrl(clock.source.url);
    const word = clock.seenOnX ? 'Confirmed by' : clock.kind === 'alert' ? 'Source' : 'Rule';
    links.push(
      sourceUrl
        ? el('a', { href: sourceUrl, target: '_blank', rel: 'noopener', text: `${word}: ${clock.source.label}` })
        : el('span', { text: `Source: ${clock.source.label}` }),
    );
  }
  if (clock.ownId) {
    const remove = el('button', { class: 'link-button', type: 'button', text: 'Remove' });
    remove.addEventListener('click', async () => {
      remove.disabled = true;
      try {
        await post(`/api/own-deadlines/${encodeURIComponent(clock.ownId)}/delete`, {});
        await ctx.refresh();
        document.getElementById('add-own')?.querySelector('summary')?.focus();
      } catch (err) {
        remove.disabled = false;
        remove.textContent = `Couldn't remove it. ${err.message}`;
      }
    });
    links.push(remove);
  }
  return links.length ? el('p', { class: 'stop-links' }, ...links) : null;
}

function stopItem(clock, ctx, { isNew, actions }) {
  const { today, profile } = ctx;
  const item = el('li', { class: 'stop', id: `stop-${clock.id}`, tabindex: '-1' });
  const body = el('div', { class: 'stop-body' });

  const name = el('h3', { class: 'stop-name', text: clock.name });
  if (isNew) name.append(el('span', { class: 'tag-new', text: 'New' }));
  body.append(
    el(
      'div',
      { class: 'stop-title' },
      name,
      clock.due && clock.kind === 'date' ? el('span', { class: 'stop-when', text: formatDate(clock.due, today) }) : null,
    ),
  );

  let reason = clock.reason || '';
  if (clock.checkedAt) reason = `${reason} Checked ${formatTime(clock.checkedAt, today)}.`.trim();
  const reasonLine = reason ? el('p', { class: 'stop-reason', text: reason }) : null;
  const links = stopLinks(clock, profile, ctx);

  if (clock.risk === 'clear') {
    // Nothing to do yet: keep the row short and the rest one click away.
    if (reasonLine || links) {
      const more = el('details', { class: 'stop-more' }, el('summary', { text: 'Details' }), reasonLine, links);
      more.open = openDetails.has(clock.id);
      more.addEventListener('toggle', () => (more.open ? openDetails.add(clock.id) : openDetails.delete(clock.id)));
      body.append(more);
    }
  } else {
    if (reasonLine) body.append(reasonLine);
    if (links) body.append(links);
  }

  for (const action of actions) body.append(approvalCard(action, ctx));
  item.append(countCell(clock), body);
  return item;
}

function whyLine(line) {
  const url = line.source_url && safeUrl(line.source_url);
  const source = !line.source_label
    ? null
    : url
      ? el('a', { href: url, target: '_blank', rel: 'noopener', text: line.source_label })
      : el('span', { text: line.source_label });
  return el('li', {}, line.text, source ? el('span', { class: 'muted', text: ' · ' }, source) : null);
}

const FACT_SOURCE = { user: 'you', document: 'a document', email: 'email' };

function renderApplications(ctx) {
  const band = document.getElementById('applications');
  const root = document.getElementById('application-review');
  if (!band || !root) return;
  const { profile, me } = ctx;
  const targets = (profile.schools || []).filter((school) => school.status === 'target');
  band.hidden = profile.stage !== 'applying';
  if (band.hidden) return;
  const draft = applicationDraft(profile.bank);
  const note = el('p', { class: 'form-error', role: 'alert', hidden: true });

  async function run(path, body) {
    note.hidden = true;
    try {
      await post(`/api/profiles/${encodeURIComponent(profile.id)}/${path}`, body);
      await ctx.refresh();
    } catch (err) {
      note.hidden = false;
      note.textContent = err.message;
    }
  }

  const schools = targets.map((school) => {
    const submitted = school.application === 'submitted';
    const button = me.demo || submitted ? null : el('button', { class: 'btn', type: 'button', text: 'I already submitted this' });
    if (button) button.addEventListener('click', () => run('application', { school_id: school.id, status: 'submitted' }));
    return el(
      'li',
      { class: 'school-card' },
      el('span', { text: APPLICATION_STATUS_LABEL[school.application] || APPLICATION_STATUS_LABEL.not_started }),
      el('span', {}, school.name),
      button,
    );
  });

  const fields = draft.fields.map((field) => {
    const source = FACT_SOURCE[field.source] || '';
    const bits = [el('span', {}, field.label)];
    if (field.confirmed) bits.push(el('span', { class: 'muted', text: `${field.value} · from ${source}` }));
    else if (field.pending) bits.push(el('span', { class: 'muted', text: `${field.pending_value} · from ${source}, not confirmed` }));
    else bits.push(el('span', { class: 'muted', text: field.required ? 'Needed before a draft can be filled.' : 'Optional.' }));
    if (!me.demo && field.pending) {
      const confirm = el('button', { class: 'btn', type: 'button', text: 'Confirm' });
      confirm.addEventListener('click', () => run('bank', { field: field.form, value: field.pending_value }));
      bits.push(confirm);
    }
    if (!me.demo && (field.confirmed || field.pending)) {
      const reject = el('button', { class: 'btn btn--quiet', type: 'button', text: 'Reject' });
      reject.addEventListener('click', () => run('bank', { field: field.form, confirmed: false }));
      bits.push(reject);
    }
    if (!me.demo && !field.confirmed) {
      const input = el('input', { type: 'text', 'aria-label': field.label, maxlength: '300', value: field.pending_value || '' });
      const save = el('button', { class: 'btn', type: 'button', text: 'Save' });
      save.addEventListener('click', () => run('bank', { field: field.form, value: input.value }));
      bits.push(input, save);
    }
    return el('li', {}, ...bits);
  });

  root.replaceChildren(
    schools.length ? el('ul', { class: 'school-list' }, ...schools) : el('p', { text: 'Add the schools you want to apply to.' }),
    el('h3', { text: 'Facts a draft can use' }),
    el('ul', { class: 'rule-list' }, ...fields),
    me.demo ? el('p', { class: 'muted', text: 'This is a sample person. Create an account to review your own application.' }) : null,
    note,
  );
}

function renderSchools(ctx, actions) {
  const { profile, store } = ctx;
  const rankBand = document.getElementById('school-rankings');
  const alertBand = document.getElementById('school-alerts');
  if (!rankBand || !alertBand) return;
  const tracking = profile.track_schools !== false;
  const schools = tracking && Array.isArray(profile.schools) ? profile.schools : [];
  const signals = rowsOf(store.school_signals).filter((row) => row.person === profile.id);
  const targets = rankSchools(schools, signals);
  const enrolled = schools.find((school) => school.status === 'enrolled') || null;
  const alerts = rowsOf(store.school_alerts).filter((row) => row.person === profile.id && (!enrolled || row.school_id === enrolled.id));

  rankBand.hidden = !targets.length;
  if (targets.length) {
    document.getElementById('school-rank-list').replaceChildren(
      ...targets.map((school) =>
        el(
          'li',
          { class: 'school-card' },
          el('p', { class: 'school-score', text: school.score == null ? '—' : String(school.score) }),
          el(
            'div',
            {},
            el('h3', {}, school.rank ? `${school.rank}. ${school.name}` : school.name, school.state ? el('span', { class: 'muted', text: ` · ${school.state}` }) : null),
            school.score == null
              ? el('p', { class: 'muted', text: 'Waiting for Scout to collect signals. No score until then.' })
              : el('ol', { class: 'school-why' }, ...school.why.map(whyLine)),
          ),
        ),
      ),
    );
  }

  alertBand.hidden = !enrolled;
  if (!enrolled) return;
  const scored = scoreSchool(signals.filter((row) => row.school_id === enrolled.id));
  const body = [
    el('h3', {}, enrolled.name, enrolled.state ? el('span', { class: 'muted', text: ` · ${enrolled.state}` }) : null),
    el('p', { class: 'muted', text: scored.score == null ? 'No support score yet.' : `Support score ${scored.score}, from the signals Scout has saved.` }),
  ];
  if (!alerts.length) body.push(el('p', { text: 'No school notices yet. They show up here after Scout checks this campus.' }));
  for (const alert of alerts) {
    const url = alert.source_url && safeUrl(alert.source_url);
    body.push(
      el(
        'article',
        { class: 'school-alert', id: `school-${alert.id}` },
        el('h4', {}, riskMark(alert.risk || 'watch', 14), alert.title),
        el('p', { text: alert.why }),
        url ? el('p', {}, el('a', { href: url, target: '_blank', rel: 'noopener', text: alert.source_label || 'Source' })) : null,
      ),
    );
    for (const action of actions.filter((item) => item.clock === alert.id)) body.push(approvalCard(action, ctx));
  }
  document.getElementById('school-alert-list').replaceChildren(...body);
}

function renderGroups(ctx, clocks, actions) {
  const { profile } = ctx;
  if (!seen.has(profile.id)) seen.set(profile.id, new Set(clocks.map((c) => c.id)));
  const known = seen.get(profile.id);

  const sections = [];
  for (const { risk, hint } of GROUPS) {
    const mine = clocks.filter((c) => c.risk === risk);
    if (!mine.length) continue;
    const headingId = `group-${risk}`;
    sections.push(
      el(
        'section',
        { class: `group group--${risk}`, 'aria-labelledby': headingId },
        el(
          'div',
          { class: 'group-head' },
          el('h2', { id: headingId }, riskMark(risk, 14), RISK_LABEL[risk]),
          el('p', { class: 'group-hint', text: hint }),
        ),
        el(
          'ol',
          { class: 'stops' },
          ...mine.map((clock) =>
            stopItem(clock, ctx, { isNew: !known.has(clock.id), actions: actions.filter((a) => a.clock === clock.id) }),
          ),
        ),
      ),
    );
  }

  // A draft whose deadline has closed still needs an answer; keep it reachable.
  // A draft for a school alert is shown on that alert, not here.
  const schoolAlertIds = new Set(rowsOf(ctx.store.school_alerts).filter((row) => row.person === profile.id).map((row) => row.id));
  const loose = actions.filter((a) => !clocks.some((c) => c.id === a.clock) && !schoolAlertIds.has(a.clock));
  if (loose.length) {
    sections.push(
      el(
        'section',
        { class: 'group', 'aria-labelledby': 'group-other' },
        el('div', { class: 'group-head' }, el('h2', { id: 'group-other', text: 'Other drafts' })),
        ...loose.map((action) => approvalCard(action, ctx)),
      ),
    );
  }

  if (!sections.length) {
    sections.push(
      ctx.me.demo
        ? el('p', { class: 'lede', text: 'No deadlines yet. They appear here after the Bots read the documents and run their first check.' })
        : el(
            'div',
            { class: 'group' },
            el('p', { class: 'lede', text: 'Nothing to count yet. Add the dates from your documents, or add a deadline of your own below.' }),
            el('p', { class: 'lead-action' }, el('a', { class: 'btn btn--primary', href: '/setup/?edit=1', text: 'Add your dates' })),
          ),
    );
  }
  const groups = document.getElementById('groups');
  groups.replaceChildren(...sections);
  if (!entered.has(profile.id)) {
    entered.add(profile.id);
    playEntrance(groups);
  }
}

// Until an account's Bots are connected nothing is being checked for it, so
// the Brief says so right under the headline. It goes once a Bot has reported
// or Check now is wired up. "Not now" puts it away until the next visit.
function renderConnectPrompt(ctx) {
  const band = document.getElementById('connect-prompt');
  if (!band) return;
  const { me, profile, store } = ctx;
  const laterKey = `waypoint.connect-later.${me.id}`;
  let later = false;
  try {
    later = sessionStorage.getItem(laterKey) === '1';
  } catch {
    // No storage: the prompt simply shows again.
  }
  const connected =
    Boolean(profile.bot_webhook?.url) || rowsOf(store.runs).some((r) => r.person === profile.id && !r.simulated && !r.sample);
  band.hidden = me.demo || connected || later;
  if (band.hidden || band.dataset.ready) return;
  band.dataset.ready = 'yes';
  document
    .getElementById('connect-prompt-line')
    .replaceChildren(
      botAvatar('case', { state: 'asleep', size: 30, detail: 'not connected' }),
      'Your Bots are asleep, so nothing is being checked for you yet. Setup takes about five minutes: install the five Bot templates in Grok Bot and give each one your key.',
    );
  document.getElementById('connect-later').addEventListener('click', () => {
    try {
      sessionStorage.setItem(laterKey, '1');
    } catch {
      // Hidden for now either way.
    }
    band.hidden = true;
    document.getElementById('headline').focus?.();
  });
}

// The first time a person's Brief opens, each group's rule draws and its rows
// come in as they scroll into view, with the day count running up to its
// number. Later redraws (a poll, an approval) change in place, so nothing
// replays under the reader.
const entered = new Set();

function playEntrance(groups) {
  arriveOnView(groups.querySelectorAll('.group'));
  arriveOnView(groups.querySelectorAll('.stop'), (stop) => {
    const num = stop.querySelector('.stop-num:not(.stop-num--word)');
    if (num) countUp(num);
  });
}

function countUp(node) {
  const final = node.textContent;
  const match = final.match(/^(\d+)(.*)$/);
  if (!match || Number(match[1]) < 2) return;
  const to = Number(match[1]);
  const began = performance.now();
  const frame = (now) => {
    const t = Math.min(1, (now - began) / 800);
    if (t >= 1 || !node.isConnected) {
      node.textContent = final;
      return;
    }
    node.textContent = `${Math.round(to * (1 - (1 - t) ** 4))}${match[2]}`;
    requestAnimationFrame(frame);
  };
  requestAnimationFrame(frame);
}

// ---- what the Bots did ----

let relay = null; // built once per person, so a running animation is not redrawn
let relayFor = null;

const fresh = new Map(); // bot name -> the run we last showed, to spot a new one
let relayBusy = false;

const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// When the Bots scroll into view they say hello: each hops in turn as the
// packet runs down the wire.
async function greet(row) {
  const bots = [...row.querySelectorAll('.relay-bot')];
  for (const bot of bots) {
    if (relayBusy) break;
    sendPacket(row, bot.dataset.bot);
    bot.classList.add('is-greeting');
    await pause(170);
  }
  await pause(700);
  bots.forEach((bot) => bot.classList.remove('is-greeting'));
  if (!relayBusy) sendPacket(row, null);
}

const shownLog = new Map(); // person -> the runs already listed, to mark a new line

function renderRelay(ctx, latest, pending) {
  const { profile, today, me } = ctx;
  const connected = Boolean(profile.bot_webhook?.url);
  const waitingOn = pending.length ? 'Manager' : null; // it holds the draft until the person approves

  const statusOf = (bot) => {
    const run = latest.get(bot.name);
    if (bot.name === waitingOn) return 'Waiting for you';
    if (!run) return me.demo ? 'No run yet' : 'Not connected';
    if (run.status === 'failed') return 'Could not finish';
    if (run.status === 'running') return 'Working';
    return formatTime(run.at, today);
  };
  const stateOf = (bot) => {
    const run = latest.get(bot.name);
    if (bot.name === waitingOn) return 'waiting';
    if (!run) return 'asleep';
    if (run.status === 'failed') return 'blocked';
    if (run.status === 'running') return 'working';
    // A run that arrived while the page was open settles in; older ones sit idle.
    const seenRun = fresh.get(`${profile.id}/${bot.name}`);
    return seenRun && seenRun !== run.id ? 'done' : 'idle';
  };

  if (!relay || relayFor !== profile.id) {
    relay = botRelay({ statusOf, stateOf });
    relayFor = profile.id;
    document.getElementById('bot-relay').replaceChildren(relay);
    arriveOnView([relay], greet);
  } else if (!relayBusy) {
    for (const bot of BOTS) {
      const item = relay.querySelector(`[data-bot="${bot.id}"]`);
      item.querySelector('.relay-status').textContent = statusOf(bot);
      setBotState(item.querySelector('.bot-avatar'), stateOf(bot), statusOf(bot));
    }
  }
  for (const bot of BOTS) {
    const run = latest.get(bot.name);
    if (run) fresh.set(`${profile.id}/${bot.name}`, fresh.get(`${profile.id}/${bot.name}`) ?? run.id);
  }

  document.getElementById('bots-intro').textContent = me.demo
    ? 'Bots are AI assistants: one Manager and four workers that check government sites, your inbox, and X for rule changes. This is what each one last did.'
    : connected
      ? 'Bots are AI assistants: one Manager and four workers that check government sites, your inbox, and X for rule changes. Yours are connected: Check now wakes the Manager, and each Bot reports here when it finishes.'
      : 'Bots are AI assistants: one Manager and four workers that check government sites, your inbox, and X for rule changes. Yours are not connected yet. Check now runs the two that work without a connection.';

  const button = document.getElementById('check-now');
  const note = document.getElementById('check-note');
  button.disabled = !ctx.live;
  button.onclick = async () => {
    button.disabled = true;
    relayBusy = true;
    ctx.setBusy(true);
    heroBot('manager', 'working', 'is running the check');
    const ask = post('/api/check', { person: profile.id, today });
    try {
      if (connected) {
        note.textContent = 'Waking your Bots.';
        await playRelay(relay, ['Manager'], ask);
        note.textContent = 'Your Bots are running. Each one shows up here when it reports.';
      } else {
        note.textContent = 'Case Clerk is reading the portal, then the Manager counts the days.';
        await playRelay(relay, ['Case Clerk', 'Manager'], ask);
        note.textContent = 'Checked just now. This was a simulated run against the mock portal.';
      }
    } catch (err) {
      note.textContent = `The check did not finish. ${err.message}`;
    }
    relayBusy = false;
    ctx.setBusy(false);
    button.disabled = false;
    await ctx.refresh();
  };
}

// The Bot's face beside its line in a log, showing how that run went.
function logAvatar(run) {
  const bot = botByName(run.bot);
  if (!bot) return null;
  const state = run.status === 'failed' ? 'blocked' : run.status === 'running' ? 'working' : 'idle';
  const avatar = botAvatar(bot.id, { state, size: 18 });
  avatar.classList.add('bot-avatar--small');
  return avatar;
}

function renderBots(ctx) {
  const { store, profile, today } = ctx;
  const runs = rowsOf(store.runs).filter((r) => r.person === profile.id);
  const latest = new Map();
  for (const run of runs) {
    const name = botName(run.bot);
    const prev = latest.get(name);
    if (!prev || String(run.at) >= String(prev.at)) latest.set(name, run);
  }
  const lines = [...latest.values()].sort((a, b) => String(a.at).localeCompare(String(b.at)));
  const waiting = rowsOf(store.actions).filter((a) => a.person === profile.id && (!a.state || a.state === 'drafted'));
  renderRelay(ctx, latest, waiting);

  const list = document.getElementById('bot-log');
  const note = document.getElementById('bot-log-note');
  if (!lines.length) {
    list.replaceChildren();
    note.textContent = ctx.me.demo
      ? 'No Bot has reported yet. The first nightly check will show up here.'
      : 'No Bot has reported for you yet. Press Check now, or connect a Bot from Settings.';
    return;
  }
  const listed = shownLog.get(profile.id);
  shownLog.set(profile.id, new Set(lines.map((run) => run.id)));
  list.replaceChildren(
    ...lines.map((run) =>
      el(
        'li',
        { class: listed && !listed.has(run.id) ? 'is-new' : null },
        el('span', { class: 'log-when', text: formatTime(run.at, today) }),
        el('span', { class: 'log-who' }, logAvatar(run), botName(run.bot) || 'Bot'),
        el(
          'span',
          { class: 'log-what' },
          `${run.status === 'failed' ? 'Failed: ' : run.status === 'running' ? 'Running: ' : ''}${run.summary || ''}${run.simulated ? ' (simulated)' : ''}${run.sample && xChecked(run) ? ' (sample)' : ''}`,
          xChecked(run) ? el('span', { class: 'log-detail', text: xChecked(run) }) : null,
        ),
      ),
    ),
  );
  const allSample = lines.every((r) => r.sample);
  note.replaceChildren(
    allSample ? 'These are sample runs. They are replaced when a Bot reports. ' : '',
    el('a', { href: `/activity/?p=${encodeURIComponent(profile.id)}`, text: 'See all activity' }),
  );

  // Fail soft: say what failed and that the last good data is still showing.
  const notice = document.getElementById('notice');
  const failed = lines.find((r) => r.status === 'failed');
  const messages = [];
  if (!ctx.live) messages.push('The store is not reachable, so this is sample data. Changes stay in this browser.');
  if (failed) {
    const good = runs.filter((r) => r.bot === failed.bot && r.status === 'ok').map((r) => r.at).sort().at(-1);
    messages.push(
      `${failed.bot} couldn't finish at ${formatTime(failed.at, today)}. ${good ? `Showing the last good check from ${formatTime(good, today)}.` : 'Nothing from this Bot is showing yet.'}`,
    );
  }
  notice.textContent = messages.join(' ');
  notice.hidden = !messages.length;
}

// ---- the demo's "send a text" buttons ----

const DEMO_TEXTS = [
  ['act_now', 'Act now'],
  ['reminder', 'Reminder'],
  ['status_change', 'Status change'],
  ['approval', 'Email waiting'],
  ['rule_change', 'Rule change'],
  ['problem', 'Check failed'],
];

// Only the demo has these, and only when texting is switched on for the site.
function renderDemoTexts(ctx) {
  const band = document.getElementById('demo-texts');
  if (!band) return;
  band.hidden = !(ctx.me.demo && ctx.live && ctx.store.features?.sms);
  document.getElementById('demo-texts-intro').textContent =
    `Each button sends that kind of text for ${ctx.profile.name.split(' ')[0]}, to the phone set up for this demo. Only the demo has these buttons.`;
  const row = document.getElementById('demo-text-buttons');
  if (band.hidden || row.dataset.ready) return;
  row.dataset.ready = 'yes';
  const status = document.getElementById('demo-text-status');
  const buttons = DEMO_TEXTS.map(([kind, label]) => {
    const button = el('button', { class: 'btn', type: 'button', text: label });
    button.addEventListener('click', async () => {
      buttons.forEach((b) => (b.disabled = true));
      status.classList.remove('is-error');
      status.textContent = 'Sending…';
      try {
        // `current` is the page as it is now: the person may have been switched.
        const sent = await post('/api/demo/text', { person: current.profile.id, kind });
        // Show the text as it reads. On a Twilio trial the phone itself only
        // shows Twilio's own test wording, so this is where the real line is seen.
        const preview = document.getElementById('demo-text-preview');
        document.getElementById('demo-text-bubble').textContent = sent.text;
        preview.hidden = false;
        preview.classList.remove('is-new');
        void preview.offsetWidth;
        preview.classList.add('is-new');
        status.textContent = sent.trial
          ? `Sent to ${sent.to}. This is the text Waypoint wrote. The Twilio account is on a trial, which swaps in Twilio's own test wording on the phone until the account is upgraded.`
          : `Sent to ${sent.to}. This is the text on the phone.`;
        await current.refresh();
      } catch (err) {
        document.getElementById('demo-text-preview').hidden = true;
        status.classList.add('is-error');
        status.textContent = err.message;
      }
      buttons.forEach((b) => (b.disabled = false));
    });
    return button;
  });
  row.replaceChildren(...buttons);
}

// ---- page ----

initPage((ctx) => {
  const { store, profile, today } = ctx;
  const clocks = buildClocks(profile, store, today);
  const actions = rowsOf(store.actions).filter((a) => a.person === profile.id);
  const order = new Map(clocks.map((c, i) => [c.id, i]));
  const pending = actions
    .filter((a) => !a.state || a.state === 'drafted')
    .sort((a, b) => (order.get(a.clock) ?? 999) - (order.get(b.clock) ?? 999));

  current = ctx;
  document.title = `Brief for ${profile.name} · Waypoint`;
  renderGuide(ctx, clocks, actions, pending);
  renderLead(ctx, clocks, pending);
  renderConnectPrompt(ctx);
  showGuide = () => {
    renderGuide(ctx, clocks, actions, pending);
    const guide = document.getElementById('guide');
    guide.scrollIntoView({ block: 'start' });
    guide.focus({ preventScroll: true });
  };
  renderGroups(ctx, clocks, actions);
  renderApplications(ctx);
  renderSchools(ctx, actions);
  renderBots(ctx);
  renderDemoTexts(ctx);
});

// Help reopens the guide in place instead of reloading the page.
document.getElementById('help-link')?.addEventListener('click', (event) => {
  event.preventDefault();
  guideOpen = true;
  remember(GUIDE_KEY, 'shown');
  showGuide?.();
});

// Add a deadline of your own. The form sits under the groups; the new deadline
// lands in its group, tagged New.
{
  const form = document.getElementById('add-own-form');
  const label = document.getElementById('own-label');
  const date = document.getElementById('own-date');
  const noteField = document.getElementById('own-note');
  const error = document.getElementById('own-error');
  const save = document.getElementById('own-save');
  if (location.hash === '#add-own') document.getElementById('add-own').open = true;
  form.addEventListener('submit', async (event) => {
    event.preventDefault();
    error.hidden = true;
    const fail = (message, field) => {
      error.textContent = message;
      error.hidden = false;
      field?.focus();
    };
    if (!label.value.trim()) return fail('Say what the deadline is.', label);
    if (!date.value) return fail('Pick the date it is due.', date);
    if (!current) return fail('The page is still loading. Try again in a moment.');
    save.disabled = true;
    try {
      const { row } = await post('/api/own-deadlines', { person: current.profile.id, label: label.value, due_date: date.value, note: noteField.value });
      form.reset();
      document.getElementById('add-own').open = false;
      await current.refresh();
      document.getElementById(`stop-own-${row.id}`)?.focus();
    } catch (err) {
      fail(`Couldn't add it. ${err.message}`);
    }
    save.disabled = false;
  });
}
