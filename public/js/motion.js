// Scroll-triggered arrivals. A node is held back until it scrolls into view,
// then arrives once (see .is-waiting and .is-arriving in app.css). Nothing is
// hidden unless this script runs, and nothing moves under reduced motion.

const reduced = () => window.matchMedia('(prefers-reduced-motion: reduce)').matches;

// onArrive(node) runs as each node comes in. Nodes that come in together get
// --order 0, 1, 2… so a list can arrive one after another.
export function arriveOnView(nodes, onArrive) {
  const list = [...nodes];
  if (!list.length || reduced() || !('IntersectionObserver' in window)) return;
  const watcher = new IntersectionObserver(
    (entries) => {
      let order = 0;
      for (const entry of entries) {
        if (!entry.isIntersecting) continue;
        const node = entry.target;
        watcher.unobserve(node);
        node.style.setProperty('--order', String(Math.min(order, 6)));
        node.classList.replace('is-waiting', 'is-arriving');
        onArrive?.(node);
        order += 1;
      }
    },
    { rootMargin: '0px 0px -8% 0px' },
  );
  for (const node of list) {
    node.classList.add('is-waiting');
    watcher.observe(node);
  }
  // A safety net: anything on screen that is somehow still held back after a
  // few seconds is shown, so a missed signal can never leave a blank section.
  setTimeout(() => {
    for (const node of list) {
      if (!node.classList.contains('is-waiting')) continue;
      const box = node.getBoundingClientRect();
      if (box.top < window.innerHeight && box.bottom > 0) {
        watcher.unobserve(node);
        node.classList.replace('is-waiting', 'is-arriving');
        onArrive?.(node);
      }
    }
  }, 4000);
}

// Every band's title and content come in once, as the band scrolls into view.
export function arriveBands() {
  arriveOnView(document.querySelectorAll('.split-label, .split-body'));
}
