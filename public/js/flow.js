// Page-to-page cross-fades are a nicety. If the browser drops one (a redirect, a
// reload mid-fade), that is not an error worth reporting.
window.addEventListener('pagereveal', (event) => {
  if (!event.viewTransition) return;
  event.viewTransition.ready.catch(() => {});
  event.viewTransition.finished.catch(() => {});
});
window.addEventListener('pageswap', (event) => {
  if (!event.viewTransition) return;
  event.viewTransition.ready.catch(() => {});
  event.viewTransition.finished.catch(() => {});
});

// Some browsers report the dropped fade on a promise the page never sees.
window.addEventListener('unhandledrejection', (event) => {
  const reason = event.reason;
  if (reason && reason.name === 'InvalidStateError' && /Transition was aborted/.test(String(reason.message))) event.preventDefault();
});
