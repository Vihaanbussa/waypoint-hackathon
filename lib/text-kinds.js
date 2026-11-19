// The words of a text message. Waypoint writes them, so every text says the
// same three things in the same order: what it is, what to do or by when, and
// where to look. A Bot only picks the kind and, for a deadline, which one; the
// date and the day count come from Waypoint's own counting, never from a Bot.
//
// `trial` is the Twilio sample text that stands in for each kind while the
// Twilio account is on a trial (a trial will not send our own wording).

export const TEXT_KINDS = {
  act_now: { needs: 'deadline', trial: 'sms_account_alerts', about: 'a deadline marked "act": something to do now' },
  reminder: { needs: 'deadline', trial: 'sms_appointment_reminders', about: 'a deadline coming up, marked "watch"' },
  status_change: { trial: 'sms_account_alerts', about: 'the case status changed on the portal' },
  approval: { trial: 'sms_account_alerts', about: 'drafted emails are waiting for the person to approve' },
  rule_change: { needs: 'deadline', trial: 'sms_account_alerts', about: 'a rule change Scout saved (pass its "alert-..." deadline_id)' },
  problem: { needs: 'bot', trial: 'sms_account_alerts', about: 'a Bot could not finish its check' },
};

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

// "2026-12-01" -> "Dec 1", with the year only when it is not this year.
export function sayDate(iso, today) {
  const [y, m, d] = String(iso).split('-').map(Number);
  if (!y || !m || !d) return '';
  return `${MONTHS[m - 1]} ${d}${String(today).slice(0, 4) === String(y) ? '' : `, ${y}`}`;
}

export function sayDays(days) {
  if (days == null || Number.isNaN(Number(days))) return '';
  const n = Number(days);
  if (n === 0) return 'due today';
  if (n < 0) return `${-n} ${n === -1 ? 'day' : 'days'} overdue`;
  return `${n} ${n === 1 ? 'day' : 'days'} left`;
}

// "Work permit card expires" + Dec 1 + 12 days -> "Work permit card expires: Dec 1, 12 days left"
function deadlineLine(clock, today) {
  const name = String(clock.name || 'A deadline').replace(/\s+/g, ' ').trim();
  const facts = [clock.due ? sayDate(clock.due, today) : '', sayDays(clock.daysLeft)].filter(Boolean).join(', ');
  if (!facts) return name;
  return `${name}${name.includes(':') ? ',' : ':'} ${facts}`;
}

const tail = (lead, link, fallback) => (link ? ` ${lead}: ${link}` : ` ${fallback}`);

// One line, ready to send. Throws a plain reason when a kind lacks what it needs.
export function composeText(kind, { clock = null, today, link = '', waiting = 0, draftWaiting = false, caseRow = null, bot = '' } = {}) {
  if (!Object.hasOwn(TEXT_KINDS, kind)) throw new Error(`"kind" must be one of: ${Object.keys(TEXT_KINDS).join(', ')}.`);
  if (TEXT_KINDS[kind].needs === 'deadline' && !clock) throw new Error(`A "${kind}" text is about one deadline. Pass its deadline_id from get_brief.`);

  if (kind === 'act_now') {
    return `Waypoint: act now. ${deadlineLine(clock, today)}.${draftWaiting ? ' A drafted email is waiting for your approval.' : ''}${tail('Open your brief', link, 'Open your Waypoint brief.')}`;
  }
  if (kind === 'reminder') {
    return `Waypoint reminder. ${deadlineLine(clock, today)}.${tail('See what to do', link, 'See what to do in your Waypoint brief.')}`;
  }
  if (kind === 'rule_change') {
    const title = String(clock.name || '').replace(/^Rule change:\s*/i, '').trim() || 'a new notice';
    return `Waypoint: a rule change may affect you: ${title}.${tail('See why', link, 'See why in your Waypoint brief.')}`;
  }
  if (kind === 'status_change') {
    const status = String(caseRow?.status || '').replace(/["\s]+/g, ' ').trim().slice(0, 90);
    if (!status) throw new Error('No case status is on file yet, so there is no change to text about.');
    const due = clock?.due || caseRow?.response_due || '';
    const respond = due ? ` Respond by ${sayDate(due, today)}${clock?.daysLeft != null ? ` (${sayDays(clock.daysLeft)})` : ''}.` : '';
    return `Waypoint: your case status changed to "${status}".${respond}${tail('See what it means', link, 'See what it means in your Waypoint brief.')}`;
  }
  if (kind === 'approval') {
    if (!(waiting > 0)) throw new Error('No emails are waiting for approval, so there is nothing to text about.');
    return `Waypoint: ${waiting} ${waiting === 1 ? 'email is' : 'emails are'} waiting for your approval. Nothing is sent until you approve.${tail('Review', link, 'Review in your Waypoint brief.')}`;
  }
  // problem
  if (!bot) throw new Error('Say which Bot could not finish: pass "bot".');
  return `Waypoint: ${bot} could not finish its check, so your deadlines show the last good check.${tail('Details', link, 'Details are in your Waypoint brief.')}`;
}
