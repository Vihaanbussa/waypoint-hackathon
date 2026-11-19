// Sign in, create an account, or step into the demo.

import { post } from './store.js';
import { botRelay } from './bots.js';
import { startNight } from './night.js';
import { arriveOnView } from './motion.js';

document.getElementById('relay').append(botRelay({ loop: true }));
startNight();
arriveOnView(document.querySelectorAll('.promise-list li'));

// The hero's loop rests while it is off screen.
const pitch = document.querySelector('.auth-pitch');
if (pitch && 'IntersectionObserver' in window) {
  new IntersectionObserver(([entry]) => pitch.classList.toggle('is-resting', !entry.isIntersecting)).observe(pitch);
}

const form = document.getElementById('auth-form');
const title = document.getElementById('form-title');
const switchText = document.getElementById('switch-text');
const switchMode = document.getElementById('switch-mode');
const nameField = document.getElementById('name-field');
const nameInput = document.getElementById('name');
const email = document.getElementById('email');
const password = document.getElementById('password');
const hint = document.getElementById('password-hint');
const submit = document.getElementById('auth-submit');
const error = document.getElementById('auth-error');
const demos = [...document.querySelectorAll('[data-demo]')];

let mode = new URLSearchParams(location.search).get('mode') === 'signup' ? 'signup' : 'signin';

// Redraws the form for the current mode (sign in or create account).
function draw() {
  const signup = mode === 'signup';
  title.textContent = signup ? 'Create your account' : 'Sign in';
  document.title = `${signup ? 'Create your account' : 'Sign in'} · Waypoint`;
  switchText.textContent = signup ? 'Already have an account?' : 'New to Waypoint?';
  switchMode.textContent = signup ? 'Sign in' : 'Create an account';
  nameField.hidden = !signup;
  hint.hidden = !signup;
  password.autocomplete = signup ? 'new-password' : 'current-password';
  submit.textContent = signup ? 'Create account' : 'Sign in';
  error.hidden = true;
}

// Shows an error and puts the cursor on the field to fix.
function fail(message, field) {
  error.textContent = message;
  error.hidden = false;
  field?.focus();
}

switchMode.addEventListener('click', () => {
  mode = mode === 'signup' ? 'signin' : 'signup';
  draw();
  (mode === 'signup' ? nameInput : email).focus();
});

// Checks the form here for quick feedback; the server checks it again.
form.addEventListener('submit', async (event) => {
  event.preventDefault();
  const signup = mode === 'signup';
  if (signup && !nameInput.value.trim()) return fail('Add your name.', nameInput);
  if (!email.value.trim()) return fail('Add your email address.', email);
  if (!password.value) return fail('Add your password.', password);
  if (signup && password.value.length < 8) return fail('Use a password of at least 8 characters.', password);

  submit.disabled = true;
  submit.textContent = signup ? 'Creating your account…' : 'Signing in…';
  try {
    if (signup) {
      await post('/api/auth/signup', { name: nameInput.value, email: email.value, password: password.value });
      location.assign('/setup/');
    } else {
      await post('/api/auth/login', { email: email.value, password: password.value });
      location.assign('/');
    }
  } catch (err) {
    submit.disabled = false;
    draw();
    fail(err.message, signup && /email/.test(err.message) ? email : password);
  }
});

// The demo needs no account: the server starts a session for the sample people.
async function openDemo() {
  demos.forEach((button) => (button.disabled = true));
  try {
    await post('/api/auth/demo', {});
    location.assign('/');
  } catch (err) {
    demos.forEach((button) => (button.disabled = false));
    title.scrollIntoView({ block: 'center' });
    fail(`Couldn't open the demo. ${err.message}`);
  }
}
demos.forEach((button) => button.addEventListener('click', openDemo));

// "Create my account" at the bottom of the page: back up to the form, ready to fill.
document.getElementById('cta-signup')?.addEventListener('click', () => {
  mode = 'signup';
  draw();
  title.scrollIntoView({ block: 'center' });
  nameInput.focus({ preventScroll: true });
});

draw();
