// Short, interruptible transitions. Respect the desktop's reduced-motion setting.
const motionPreference = matchMedia('(prefers-reduced-motion: reduce)');
const activeMotions = new WeakMap();
function reveal(element, delay = 0) {
  if (!element || element.closest('[hidden]') || motionPreference.matches) return;
  activeMotions.get(element)?.cancel();
  const animation = element.animate([
    { opacity: 0, transform: 'translateY(6px)' },
    { opacity: 1, transform: 'translateY(0)' }
  ], { duration: 200, delay, easing: 'cubic-bezier(.2,.7,.2,1)', fill: 'backwards' });
  activeMotions.set(element, animation);
}
motionPreference.addEventListener('change', () => {
  if (motionPreference.matches) document.getAnimations().forEach(animation => animation.cancel());
});
function moveSelection(group, button) {
  const previous = group.querySelector('.active');
  if (previous === button) return;
  const from = previous?.getBoundingClientRect();
  group.querySelectorAll(':scope > button').forEach(item => item.classList.toggle('active', item === button));
  if (!from || motionPreference.matches) return;
  const to = button.getBoundingClientRect();
  // Animate the highlight separately so labels stay still and remain readable.
  activeMotions.get(group)?.cancel();
  const animation = group.animate([
    { '--selection-x': `${from.left - to.left}px`, '--selection-y': `${from.top - to.top}px`, '--selection-scale': `${from.width / to.width}` },
    { '--selection-x': '0px', '--selection-y': '0px', '--selection-scale': '1' }
  ], { duration: 220, easing: 'cubic-bezier(.2,.7,.2,1)' });
  activeMotions.set(group, animation);
}
function replaceContent(element, html) {
  if (element._renderedHTML === html && element.innerHTML === element._renderedDOM) return false;
  element.innerHTML = html;
  element._renderedHTML = html;
  element._renderedDOM = element.innerHTML;
  return true;
}
// Keep existing rows and switches mounted when snapshots arrive in the background.
function reconcileRows(container, html, keyOf, update) {
  const template = document.createElement('template');
  template.innerHTML = html;
  const existing = new Map([...container.children].map(element => [keyOf(element), element]));
  const keep = new Set();
  [...template.content.children].forEach((next, index) => {
    const key = keyOf(next);
    let row = key && existing.get(key);
    const fresh = !row;
    if (!row) row = next;
    else if (update) update(row, next);
    keep.add(row);
    if (container.children[index] !== row) container.insertBefore(row, container.children[index] || null);
    if (fresh) reveal(row, Math.min(index, 5) * 24);
  });
  [...container.children].forEach(row => { if (!keep.has(row)) row.remove(); });
}
