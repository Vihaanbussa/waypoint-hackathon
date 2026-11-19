// Demo controls: change what the mock portal shows, rehearse without a Bot,
// and reset the store.

import { get, post } from './store.js';

const $ = (id) => document.getElementById(id);

// Preset statuses with the wording the real portal uses.
const STATUSES = [
  { status: 'Case Was Received', detail: 'We received your Form I-765, Application for Employment Authorization.' },
  { status: 'Request for Evidence Was Sent', detail: 'We sent a request for evidence. Respond by the date on your notice.' },
  { status: 'Case Was Approved', detail: 'We approved your Form I-765, Application for Employment Authorization.' },
  { status: 'Card Is Being Produced', detail: 'Your new card is being produced.' },
];

let cases = []; // what the portal currently shows, one row per receipt

// Loads the chosen case's current values into the form.
function fillForm() {
  const record = cases.find((c) => c.receipt === $('receipt').value);
  if (!record) return;
  $('status').value = STATUSES.some((s) => s.status === record.status) ? record.status : STATUSES[0].status;
  $('detail').value = record.detail || '';
  $('response-due').value = record.response_due || '';
}

// Fetches the cases and fills the pickers.
async function load() {
  try {
    ({ cases } = await get('/api/portal/cases'));
  } catch (err) {
    $('status-message').textContent = `The demo controls need the server running. ${err.message}`;
    return;
  }
  $('receipt').replaceChildren(...cases.map((c) => new Option(`${c.receipt}, ${c.title}`, c.receipt)));
  $('status').replaceChildren(...STATUSES.map((s) => new Option(s.status, s.status)));
  fillForm();
}

$('receipt').addEventListener('change', fillForm);
$('status').addEventListener('change', () => {
  const preset = STATUSES.find((s) => s.status === $('status').value);
  if (preset) $('detail').value = preset.detail;
  if ($('status').value !== 'Request for Evidence Was Sent') $('response-due').value = '';
});

$('status-form').addEventListener('submit', async (event) => {
  event.preventDefault();
  try {
    const saved = await post('/api/portal/case', {
      receipt: $('receipt').value,
      status: $('status').value,
      detail: $('detail').value,
      response_due: $('response-due').value,
    });
    cases = cases.map((c) => (c.receipt === saved.receipt ? { ...c, ...saved } : c));
    $('status-message').textContent = `Saved. The portal now shows "${saved.status}".`;
  } catch (err) {
    $('status-message').textContent = `Not saved. ${err.message}`;
  }
});

$('simulate').addEventListener('click', async () => {
  try {
    const { row } = await post('/api/simulate/case-clerk', { receipt: $('receipt').value });
    $('simulate-message').textContent = `Done. The store now has "${row.status}", marked simulated.`;
  } catch (err) {
    $('simulate-message').textContent = `Did not run. ${err.message}`;
  }
});

$('reset').addEventListener('click', async () => {
  if (!window.confirm('Reset every table to the sample data? Approvals and Bot reports will be removed.')) return;
  try {
    await post('/api/reset');
    await load();
    $('reset-message').textContent = 'Reset. The store is back to the sample data.';
  } catch (err) {
    $('reset-message').textContent = `Not reset. ${err.message}`;
  }
});

load();
