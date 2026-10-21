// The little notebook cat: wanders, sits & watches the cursor, naps.

const MARKUP = `
<svg class="pose-walk" viewBox="0 0 120 84" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round">
  <path class="ground" d="M8 80.5 H112"/>
  <path class="walk-tail" d="M31 52 Q18 50 19 36 Q20 28 26 31"/>
  <path class="leg b" d="M38 57 L38 79 L42.5 79"/>
  <path class="leg a" d="M76 57 L76 79 L80.5 79"/>
  <g class="walk-body">
    <path class="fill" d="M30 53 Q31 44 47 44 L72 44 Q87 44 87 54 Q87 62 74 62 L43 62 Q30 62 30 53 Z"/>
    <path d="M52 47 Q54 50 52 53 M60 46.5 Q62 50 60 53"/>
    <path class="fill" d="M78 45 Q75 31 88 28.5 Q101 28 102 40 Q101 50.5 89 50.5 Q80 50.5 78 45 Z"/>
    <path class="fill" d="M80.5 34 L80 21.5 L88.5 29"/>
    <path class="fill" d="M92.5 28.6 L99.5 20 L100 33.5"/>
    <path d="M94.5 37.5 Q95.6 36.2 96.6 37.5"/>
    <path d="M101.2 42.4 L102.3 42.8 L101.6 43.9 Z" fill="currentColor"/>
    <path d="M98 45.5 L109 44.5 M98 47.5 L108 49.5"/>
  </g>
  <path class="leg a" d="M45 57 L45 79 L49.5 79"/>
  <path class="leg b" d="M83 56 L83 79 L87.5 79"/>
</svg>
<svg class="pose-sit" viewBox="0 0 120 84" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round">
  <path class="ground" d="M20 80.5 H100"/>
  <path class="tail" d="M73 77 Q95 77 95 60 Q95 51 88 52.5"/>
  <path class="fill" d="M45 79.5 Q40 61 50 51 Q60 44 70 51 Q80 61 75 79.5 Z"/>
  <path d="M56 59 Q60 63 64 59"/>
  <path class="fill" d="M50.5 79.5 Q50 72 54 72 Q57.5 72 57.5 79.5"/>
  <path class="fill" d="M62.5 79.5 Q62.5 72 66 72 Q70 72 69.5 79.5"/>
  <g class="head">
    <path class="fill ear l" d="M44.5 27 L42 9.5 L55 19.5"/>
    <path class="fill ear r" d="M65 19.5 L78 9.5 L75.5 27"/>
    <path d="M46 23 L45 15.5 L50.5 20 M74 23 L75 15.5 L69.5 20"/>
    <path class="fill" d="M42 36 Q40 21.5 52 19 Q60 17.2 68 19 Q80 21.5 78 36 Q77 48.5 60 49 Q43 48.5 42 36 Z"/>
    <g class="eyes-open">
      <path class="fill" d="M52 29.2 Q55.6 29.3 55.7 33 Q55.6 36.6 52 36.7 Q48.4 36.6 48.3 33 Q48.4 29.3 52 29.2 Z"/>
      <path class="fill" d="M68 29.2 Q71.6 29.3 71.7 33 Q71.6 36.6 68 36.7 Q64.4 36.6 64.3 33 Q64.4 29.3 68 29.2 Z"/>
      <circle class="pupil" cx="52" cy="33" r="1.9" fill="currentColor" stroke="none"/>
      <circle class="pupil" cx="68" cy="33" r="1.9" fill="currentColor" stroke="none"/>
    </g>
    <g class="eyes-closed">
      <path d="M48.6 33.4 Q52 36 55.4 33.4"/>
      <path d="M64.6 33.4 Q68 36 71.4 33.4"/>
    </g>
    <path d="M58.4 38.6 L61.6 38.6 L60 40.4 Z" fill="currentColor"/>
    <path d="M60 40.4 Q59 43.4 56 42.4 M60 40.4 Q61 43.4 64 42.4"/>
    <path d="M47.5 39 L37 37 M47.5 41.5 L37.5 42.5 M72.5 39 L83 37 M72.5 41.5 L82.5 42.5"/>
  </g>
  <path class="heart" d="M84 18 Q84 13.5 88 14.5 Q92 13.5 92 18 Q91 21.5 88 24 Q85 21.5 84 18 Z" fill="currentColor"/>
</svg>
<svg class="pose-sleep" viewBox="0 0 120 84" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round">
  <path class="ground" d="M8 80.5 H112"/>
  <g class="sleep-body">
    <path class="fill" d="M28 79.5 Q24 57 46 50.5 Q62 45.5 80 49 Q101 54.5 102 70 Q102.5 79.5 92 79.5 Z"/>
    <path d="M68 51.5 Q70.5 55.5 68 59.5 M77 52.5 Q79.5 56.5 77 60.5 M86 55.5 Q88 59 86 62.5"/>
    <path class="fill" d="M92 79.5 Q108.5 79 107 68.5 Q105.5 61 99 63.5"/>
    <path class="fill" d="M19.5 59 L18 45.5 L28.5 52.5"/>
    <path class="fill" d="M37 51.5 L44.5 42 L46.5 56.5"/>
    <path class="fill" d="M17 70 Q15 56 30 52 Q45 49.5 48.5 62 Q50.5 77 36 79 Q21 79.5 17 70 Z"/>
    <path d="M22.5 64.5 Q25.5 67.5 28.5 64.5 M35 64.5 Q38 67.5 41 64.5"/>
    <path d="M31 70 L33 71.4 L35 70"/>
    <path d="M42 79.4 Q49 74 57 79.4"/>
  </g>
  <g class="zzz"><text x="44" y="40">z</text><text x="52" y="32">z</text><text x="58" y="25">z</text></g>
</svg>
<div class="bubble"></div>`;

const SAYINGS = { wake: ['mrrp?', '*yawn*', 'oh hi'], pet: ['purrr', 'mew!', '♡', 'prrrt'], sit: ['…', 'mew', 'new mail?'] };
const pick = (a) => a[Math.floor(Math.random() * a.length)];
const rand = (a, b) => a + Math.random() * (b - a);

export function mountCat(stage) {
  const el = document.createElement('div');
  el.className = 'cat';
  el.setAttribute('role', 'img');
  el.setAttribute('aria-label', 'A little doodle cat');
  el.title = 'pet the cat';
  el.innerHTML = MARKUP; // static, trusted markup
  stage.appendChild(el);



  const bubble = el.querySelector('.bubble');
  const pupils = [...el.querySelectorAll('.pupil')];
  const reduce = matchMedia('(prefers-reduced-motion: reduce)').matches;
  const W = 120;
  let x = 10, target = 10, state = 'sit', until = 0, raf = 0, last = 0, alive = true;
  let blinkAt = 0, twitchAt = 0, bubbleTm = 0, pointer = null;

  const maxX = () => Math.max(0, stage.clientWidth - W);
  const setPose = (p) => { el.dataset.pose = p; el.classList.toggle('walking', p === 'walk'); };
  const say = (t) => {
    bubble.textContent = t;
    bubble.classList.add('show');
    clearTimeout(bubbleTm);
    bubbleTm = setTimeout(() => bubble.classList.remove('show'), 1800);
  };

  function enter(next, now) {
    state = next;
    if (next === 'walk') {
      const m = maxX();
      let t = rand(0, m);
      if (Math.abs(t - x) < 40) t = x > m / 2 ? rand(0, m / 3) : rand(m * 2 / 3, m);
      target = t;
      el.classList.toggle('flip', target < x);
      setPose('walk');
    } else if (next === 'sit') {
      until = now + rand(5000, 11000);
      setPose('sit');
    } else if (next === 'sleep') {
      until = now + rand(12000, 24000);
      setPose('sleep');
      el.classList.remove('blink');
    }
  }

  function decide(now) {
    const r = Math.random();
    if (reduce) return enter(state === 'sleep' ? 'sit' : (r < 0.5 ? 'sleep' : 'sit'), now);
    if (state === 'walk') return enter(r < 0.6 ? 'sit' : r < 0.85 ? 'sleep' : 'walk', now);
    if (state === 'sit') return enter(r < 0.65 ? 'walk' : 'sleep', now);
    return enter('sit', now); // waking up
  }

  function lookAt() {
    if (state !== 'sit' || !pointer) { pupils.forEach(p => p.setAttribute('transform', '')); return; }
    const r = el.getBoundingClientRect();
    const ex = r.left + r.width * 0.5, ey = r.top + r.height * 0.39;
    const dx = pointer.x - ex, dy = pointer.y - ey;
    const d = Math.hypot(dx, dy) || 1;
    const k = Math.min(1.7, d / 60);
    pupils.forEach(p => p.setAttribute('transform', `translate(${(dx / d * k).toFixed(2)} ${(dy / d * k).toFixed(2)})`));
  }

  function tick(now) {
    if (!alive) return;
    raf = requestAnimationFrame(tick);
    if (document.hidden) { last = now; return; }
    const dt = Math.min(64, now - (last || now));
    last = now;
    if (state === 'walk') {
      const dir = Math.sign(target - x);
      x += dir * dt * 0.03;
      if ((dir > 0 && x >= target) || (dir < 0 && x <= target) || dir === 0) { x = target; decide(now); }
    } else if (now > until) decide(now);
    x = Math.min(x, maxX());
    el.style.transform = `translateX(${x.toFixed(1)}px)`;
    if (state === 'sit') {
      if (now > blinkAt) {
        el.classList.add('blink');
        setTimeout(() => el.classList.remove('blink'), 140);
        blinkAt = now + rand(1800, 5000);
      }
      if (now > twitchAt) {
        el.classList.remove('twitch'); void el.offsetWidth; el.classList.add('twitch');
        twitchAt = now + rand(4000, 9000);
      }
      lookAt();
    }
  }

  const onMove = (e) => { pointer = { x: e.clientX, y: e.clientY }; };
  const onClick = () => {
    const now = performance.now();
    if (state === 'sleep') { enter('sit', now); say(pick(SAYINGS.wake)); return; }
    if (state === 'walk') { enter('sit', now); say(pick(SAYINGS.sit)); return; }
    until = now + 6000;
    el.classList.remove('happy'); void el.offsetWidth; el.classList.add('happy');
    setTimeout(() => el.classList.remove('happy'), 1400);
    say(pick(SAYINGS.pet));
  };
  el.addEventListener('click', onClick);
  document.addEventListener('pointermove', onMove, { passive: true });

  // start curled up asleep like in the notebook margin, then wake up
  enter(reduce ? 'sit' : 'sleep', performance.now());
  until = performance.now() + rand(3500, 6000);
  raf = requestAnimationFrame(tick);

  return {
    el,
    nudge(text) { const now = performance.now(); if (state !== 'sit') enter('sit', now); say(text); },
    destroy() {
      alive = false; cancelAnimationFrame(raf);
      document.removeEventListener('pointermove', onMove);
      el.remove();
    },
  };
}
