(function () {
  var reduce = window.matchMedia('(prefers-reduced-motion: reduce)').matches;

  // Spotlight: la lueur suit le pointeur / le doigt sur chaque carte.
  document.querySelectorAll('.link-btn').forEach(function (el) {
    function move(e) {
      var r = el.getBoundingClientRect();
      el.style.setProperty('--mx', e.clientX - r.left + 'px');
      el.style.setProperty('--my', e.clientY - r.top + 'px');
    }
    el.addEventListener('pointermove', move);
    el.addEventListener('pointerdown', move);
  });

  // Tagline: machine à écrire qui tourne sur la liste de config.taglines.
  var tag = document.querySelector('.tagline');
  if (!tag) return;
  var list;
  try { list = JSON.parse(tag.getAttribute('data-taglines')); } catch (e) { return; }
  if (!list || list.length < 2 || reduce) return;

  var i = 0, n = 0, deleting = false;
  function tick() {
    var word = list[i];
    n += deleting ? -1 : 1;
    tag.textContent = word.slice(0, n);
    var wait = deleting ? 35 : 70;
    if (!deleting && n === word.length) { deleting = true; wait = 1800; }
    else if (deleting && n === 0) { deleting = false; i = (i + 1) % list.length; wait = 350; }
    setTimeout(tick, wait);
  }
  tag.textContent = '';
  tick();
})();
