// Liquid Gradient (uilayouts) — porte vanilla do componente <Liquid>.
// 7 camadas sobrepostas, cada uma um <svg> com um <radialGradient> cujo
// gradientTransform percorre, em loop linear, os 4 estados abaixo na ordem
// svg1→svg2→svg3→svg4→svg3→svg2→svg1. Os mix-blend-mode entre as camadas +
// as rotações criam o padrão "líquido". Sem React / motion / Tailwind / deps.

const SVG_T = {
  svg1: 'translate(287.5 280) rotate(-29.0546) scale(689.807 1000)',
  svg2: 'translate(126.5 418.5) rotate(-64.756) scale(533.444 773.324)',
  svg3: 'translate(264.5 339.5) rotate(-42.3022) scale(946.451 1372.05)',
  svg4: 'translate(860.5 420) rotate(-153.984) scale(957.528 1388.11)'
};
const ORDER = ['svg1', 'svg2', 'svg3', 'svg4', 'svg3', 'svg2', 'svg1'];

// Stops finais do gradiente (no original os stops têm transition duration:0,
// então efetivamente ficam nos valores de svg1). offset + chave de cor.
const STOPS = [
  [0, 'color1'], [0.188423, 'color2'], [0.260417, 'color3'], [0.328792, 'color4'],
  [0.328892, 'color5'], [0.328992, 'color1'], [0.442708, 'color6'], [0.537556, 'color7'],
  [0.631738, 'color1'], [0.725645, 'color8'], [0.817779, 'color9'], [0.84375, 'color10'],
  [0.90569, 'color1'], [1, 'color11']
];

// Posição / rotação / blend de cada uma das 7 camadas (do componente <Liquid>).
const LAYERS = [
  { s: 1, x: '-50%', y: '-50%', r: 0, b: 'difference' },
  { s: 1, x: '-50%', y: '-50%', r: 164.971, b: 'difference' },
  { s: 1, x: '-53%', y: '-53%', r: -11.61, b: 'difference' },
  { s: 0, x: '-50%', y: '-57%', r: -179.012, b: 'difference' },
  { s: 0, x: '-57%', y: '-50%', r: -29.722, b: 'difference' },
  { s: 0, x: '-62%', y: '-24%', r: 160.227, b: 'difference' },
  { s: 0, x: '-67%', y: '-29%', r: 180, b: 'hard-light' }
];

const NS = 'http://www.w3.org/2000/svg';
const NUM = /-?\d+(?:\.\d+)?/g;
const parseT = (str) => str.match(NUM).map(Number);
const fmtT = (a) =>
  `translate(${a[0]} ${a[1]}) rotate(${a[2]}) scale(${a[3]} ${a[4]})`;
const lerp = (a, b, f) => a + (b - a) * f;

let _uid = 0;

export function initLiquid(container, { colors, dur = 10 } = {}) {
  if (!container) return null;
  const uid = 'lq' + ++_uid;
  container.innerHTML = '';

  const orderT = ORDER.map((k) => parseT(SVG_T[k]));
  const grads = [];

  LAYERS.forEach((L, idx) => {
    const layer = document.createElement('div');
    layer.style.cssText =
      'position:absolute;top:50%;left:50%;' +
      `width:${L.s ? 210 : 360}%;height:${L.s ? 57 : 99}%;` +
      `transform:translate(${L.x},${L.y}) rotate(${L.r}deg);` +
      `mix-blend-mode:${L.b};will-change:transform;`;

    const svg = document.createElementNS(NS, 'svg');
    svg.setAttribute('viewBox', '0 0 1030 280');
    svg.setAttribute('preserveAspectRatio', 'none');
    svg.style.cssText = 'width:100%;height:100%;display:block;';

    const gid = `${uid}-${idx}`;
    const rect = document.createElementNS(NS, 'rect');
    rect.setAttribute('width', '1030');
    rect.setAttribute('height', '280');
    rect.setAttribute('rx', '140');
    rect.setAttribute('fill', `url(#${gid})`);

    const defs = document.createElementNS(NS, 'defs');
    const rg = document.createElementNS(NS, 'radialGradient');
    rg.setAttribute('id', gid);
    rg.setAttribute('cx', '0');
    rg.setAttribute('cy', '0');
    rg.setAttribute('r', '1');
    rg.setAttribute('gradientUnits', 'userSpaceOnUse');
    rg.setAttribute('gradientTransform', SVG_T.svg1);

    STOPS.forEach(([offset, key]) => {
      const st = document.createElementNS(NS, 'stop');
      st.setAttribute('offset', offset);
      st.setAttribute('stop-color', colors[key] || '#ffffff');
      rg.appendChild(st);
    });

    defs.appendChild(rg);
    svg.appendChild(rect);
    svg.appendChild(defs);
    layer.appendChild(svg);
    container.appendChild(layer);
    grads.push(rg);
  });

  const reduce = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  const period = (reduce ? dur * 5 : dur) * 1000;
  const segs = ORDER.length - 1;

  let raf = 0;
  let running = false;
  let t0 = performance.now();
  let last = 0;

  const frame = (now) => {
    // ~30fps é suficiente e barato (só reescreve gradientTransform)
    if (now - last >= 32) {
      last = now;
      // módulo sempre não-negativo — o 1º timestamp do rAF pode vir "antes" de t0
      const elapsed = ((now - t0) % period + period) % period;
      const p = (elapsed / period) * segs;
      const i = Math.min(segs - 1, Math.max(0, Math.floor(p)));
      const f = p - i;
      const a = orderT[i];
      const b = orderT[i + 1];
      const tr = fmtT([
        lerp(a[0], b[0], f), lerp(a[1], b[1], f), lerp(a[2], b[2], f),
        lerp(a[3], b[3], f), lerp(a[4], b[4], f)
      ]);
      for (let g = 0; g < grads.length; g++) grads[g].setAttribute('gradientTransform', tr);
    }
    raf = requestAnimationFrame(frame);
  };

  const play = () => {
    if (running) return;
    running = true;
    t0 = performance.now() - (t0 ? 0 : 0);
    raf = requestAnimationFrame(frame);
  };
  const pause = () => {
    running = false;
    cancelAnimationFrame(raf);
  };
  const onVisibility = () => (document.hidden ? pause() : play());
  document.addEventListener('visibilitychange', onVisibility);
  play();

  return {
    play,
    pause,
    destroy() {
      pause();
      document.removeEventListener('visibilitychange', onVisibility);
      container.innerHTML = '';
    }
  };
}

// Paleta azul do exemplo oficial do GitHubButton (uilayouts).
export const LIQUID_BLUE = {
  color1: '#FFFFFF', color2: '#1E10C5', color3: '#9089E2', color4: '#FCFCFE',
  color5: '#F9F9FD', color6: '#B2B8E7', color7: '#0E2DCB', color8: '#0017E9',
  color9: '#4743EF', color10: '#7D7BF4', color11: '#0B06FC', color12: '#C5C1EA',
  color13: '#1403DE', color14: '#B6BAF6', color15: '#C1BEEB', color16: '#290ECB',
  color17: '#3F4CC0'
};
