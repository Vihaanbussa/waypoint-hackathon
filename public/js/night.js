// The sign-in page's story: one night with the Bots. Scrolling moves the clock.
// As each step reaches the middle of the screen, the stage beside it shows that
// Bot at work and adds what it found to a small Brief.
//
// Without this script the steps still read top to bottom and the stage shows
// the finished Brief.

import { BOTS, botRelay, setBotState, sendPacket } from './bots.js';

export function startNight() {
  const stage = document.getElementById('night-stage');
  const list = document.getElementById('night-steps');
  const steps = [...(list?.children ?? [])];
  if (!stage || !steps.length || !('IntersectionObserver' in window)) return;

  const clock = document.getElementById('night-clock');
  const rows = [...document.querySelectorAll('#night-brief > li')];
  const approved = rows.find((row) => row.querySelector('.night-swap'));
  const order = steps.map((step) => step.dataset.bot);
  const last = steps.length - 1;

  const relay = botRelay({ stateOf: () => 'asleep' });
  document.getElementById('night-relay').append(relay);
  const faceOf = (id) => relay.querySelector(`[data-bot="${id}"] .bot-avatar`);

  let at = -1;
  function show(i) {
    if (i === at) return;
    const forward = i > at;
    at = i;

    steps.forEach((step, n) => {
      step.classList.toggle('is-on', n === i);
      step.classList.toggle('is-past', n < i);
    });
    // Fill the route line down to this step's dot.
    list.style.setProperty('--p', String((steps[i].offsetTop + 18) / list.offsetHeight));

    const time = steps[i].dataset.time;
    if (clock.textContent !== time) {
      clock.textContent = time;
      clock.classList.remove('tick-up', 'tick-down');
      void clock.offsetWidth;
      clock.classList.add(forward ? 'tick-up' : 'tick-down');
    }

    const latest = i === last ? approved : rows.findLast((row) => Number(row.dataset.from) <= i);
    for (const row of rows) {
      row.classList.toggle('is-on', Number(row.dataset.from) <= i);
      row.classList.toggle('is-latest', row === latest);
    }
    stage.classList.toggle('is-morning', i === last);

    for (const bot of BOTS) {
      const turn = order.indexOf(bot.id);
      // Intake Clerk has no turn at night: it waits for a document.
      const state = turn === -1 ? 'idle' : turn < i ? 'done' : turn === i ? 'working' : 'asleep';
      setBotState(faceOf(bot.id), state);
    }
    sendPacket(relay, order[i] || null);
  }

  stage.classList.add('is-live');
  list.classList.add('is-live');
  show(0);

  // A thin band across the middle of the screen: the step inside it is "now".
  // Whenever a step crosses the band, take the last step that has passed the
  // middle. That also holds after a jump straight past the whole story.
  const watcher = new IntersectionObserver(
    () => {
      const middle = window.innerHeight / 2;
      let now = 0;
      steps.forEach((step, n) => {
        if (step.getBoundingClientRect().top < middle) now = n;
      });
      show(now);
    },
    { rootMargin: '-45% 0px -45% 0px' },
  );
  steps.forEach((step) => watcher.observe(step));
}
