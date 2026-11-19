// The mock portal a Case Clerk Bot signs in to and reads, like a person would.
// Field ids are stable so a Bot can find them: #case-status, #case-last-updated…

import { get, post } from './store.js';

// The receipts this sign-in may read, kept for the tab only.
const SESSION_KEY = 'mockportal.receipts';
const $ = (id) => document.getElementById(id);

// 2026-03-01 -> March 1, 2026. Done by hand to avoid timezone shifts.
function longDate(iso) {
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(String(iso ?? ''));
  if (!m) return '';
  const months = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
  return `${months[Number(m[2]) - 1]} ${Number(m[3])}, ${m[1]}`;
}

// Receipts from the last sign-in; empty when signed out or storage is blocked.
function receipts() {
  try {
    return JSON.parse(sessionStorage.getItem(SESSION_KEY)) || [];
  } catch {
    return [];
  }
}

// Loads the first receipt's status into the fixed-id fields a Bot reads.
async function showCase() {
  const [receipt] = receipts();
  if (!receipt) return showLogin();
  $('login-view').hidden = true;
  $('case-view').hidden = false;
  try {
    const record = await get(`/api/portal/case?receipt=${encodeURIComponent(receipt)}`);
    $('case-receipt').textContent = record.receipt;
    $('case-form').textContent = record.form || '';
    $('case-status').textContent = record.status || '';
    $('case-detail').textContent = record.detail || '';
    $('case-last-updated').textContent = longDate(record.last_changed);
    $('case-response-due').textContent = record.response_due ? longDate(record.response_due) : 'None';
    $('case-message').textContent = `Checked at ${new Date().toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' })}.`;
  } catch (err) {
    $('case-message').textContent = `Could not load the case. ${err.message}`;
  }
}

function showLogin() {
  $('case-view').hidden = true;
  $('login-view').hidden = false;
}

$('login-form').addEventListener('submit', async (event) => {
  event.preventDefault();
  $('login-message').textContent = '';
  try {
    const result = await post('/api/portal/login', { username: $('username').value.trim(), password: $('password').value });
    sessionStorage.setItem(SESSION_KEY, JSON.stringify(result.receipts));
    $('password').value = '';
    await showCase();
  } catch (err) {
    $('login-message').textContent = err.message;
  }
});

$('refresh').addEventListener('click', showCase);
$('sign-out').addEventListener('click', () => {
  sessionStorage.removeItem(SESSION_KEY);
  showLogin();
});

if (receipts().length) showCase();
