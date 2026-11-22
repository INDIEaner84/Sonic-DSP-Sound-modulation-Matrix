/* Sonic DSP — UI Bausteine
 * Knobs, Segment-Schalter, Mod-Wheel, Modulationsmatrix, Keyboard, Scope.
 */

import { SOURCES, DESTS, clamp, state } from './state.js';

const SVG_NS = 'http://www.w3.org/2000/svg';
const KNOB_ARC = 'M 11.272 36.728 A 18 18 0 1 1 36.728 36.728';
const KNOB_ARC_LEN = 18 * ((270 * Math.PI) / 180);

/* ------------------------------------------------------------- Formatierung */

export const fmt = {
  hz: (v) => (v >= 1000 ? (v / 1000).toFixed(v >= 10000 ? 1 : 2) + ' kHz' : Math.round(v) + ' Hz'),
  sec: (v) => (v < 1 ? Math.round(v * 1000) + ' ms' : v.toFixed(2) + ' s'),
  pct: (v) => Math.round(v * 100) + ' %',
  cents: (v) => (v > 0 ? '+' : '') + Math.round(v) + ' ct',
  oct: (v) => (v > 0 ? '+' : '') + v + ' OCT',
  rate: (v) => (v < 1 ? v.toFixed(2) : v.toFixed(1)) + ' Hz',
  num: (v) => String(Math.round(v * 10) / 10),
};

/* ---------------------------------------------------------------- SVG-Helfer */

function svgEl(tag, attrs) {
  const el = document.createElementNS(SVG_NS, tag);
  for (const k in attrs) el.setAttribute(k, String(attrs[k]));
  return el;
}

/* -------------------------------------------------------------------- Knobs */

export function createKnob(parent, o) {
  const opts = {
    min: 0,
    max: 1,
    step: 0,
    curve: 'lin',
    format: (v) => String(v),
    sensitivity: 170,
    ...o,
  };

  const wrap = document.createElement('div');
  wrap.className = 'knob-wrap';

  const knob = document.createElement('div');
  knob.className = 'knob';
  knob.tabIndex = 0;
  knob.setAttribute('role', 'slider');
  knob.setAttribute('aria-label', opts.label || '');
  knob.setAttribute('aria-valuemin', String(opts.min));
  knob.setAttribute('aria-valuemax', String(opts.max));

  const svg = svgEl('svg', { viewBox: '0 0 48 48', 'aria-hidden': 'true' });
  const track = svgEl('path', { d: KNOB_ARC, class: 'k-track' });
  const fill = svgEl('path', { d: KNOB_ARC, class: 'k-fill' });
  fill.style.strokeDasharray = String(KNOB_ARC_LEN);
  const cap = svgEl('circle', { cx: 24, cy: 24, r: 13, class: 'k-cap' });
  const needle = svgEl('line', { x1: 24, y1: 24, x2: 24, y2: 11.5, class: 'k-needle' });
  const dot = svgEl('circle', { cx: 24, cy: 24, r: 1.8, class: 'k-dot' });
  svg.append(track, fill, cap, needle, dot);

  const valueEl = document.createElement('div');
  valueEl.className = 'k-value';

  knob.appendChild(svg);
  wrap.appendChild(knob);
  wrap.appendChild(valueEl);

  if (opts.label) {
    const labelEl = document.createElement('div');
    labelEl.className = 'k-label';
    labelEl.textContent = opts.label;
    wrap.appendChild(labelEl);
  }

  let value = clamp(opts.value != null ? opts.value : opts.min, opts.min, opts.max);

  const toNorm = (v) =>
    opts.curve === 'log'
      ? Math.log(Math.max(v, opts.min) / opts.min) / Math.log(opts.max / opts.min)
      : (v - opts.min) / (opts.max - opts.min);

  const fromNorm = (n) => {
    let v = opts.curve === 'log' ? opts.min * Math.pow(opts.max / opts.min, n) : opts.min + (opts.max - opts.min) * n;
    if (opts.step) v = Math.round(v / opts.step) * opts.step;
    return clamp(v, opts.min, opts.max);
  };

  function render() {
    const n = clamp(toNorm(value), 0, 1);
    fill.style.strokeDashoffset = String(KNOB_ARC_LEN * (1 - n));
    needle.setAttribute('transform', `rotate(${-135 + 270 * n} 24 24)`);
    valueEl.textContent = opts.format(value);
    knob.setAttribute('aria-valuenow', String(Math.round(value * 1000) / 1000));
  }

  function commit() {
    render();
    if (opts.onChange) opts.onChange(value);
  }

  function setValue(v, silent = false) {
    const nv = clamp(Number(v) || 0, opts.min, opts.max);
    if (opts.step) {
      const snapped = clamp(Math.round(nv / opts.step) * opts.step, opts.min, opts.max);
      value = snapped;
    } else {
      value = nv;
    }
    if (silent) render();
    else commit();
  }

  /* Drag */
  knob.addEventListener('pointerdown', (e) => {
    if (e.pointerType === 'mouse' && e.button !== 0) return;
    e.preventDefault();
    knob.focus();
    knob.setPointerCapture(e.pointerId);
    const startY = e.clientY;
    const startN = clamp(toNorm(value), 0, 1);
    knob.classList.add('dragging');

    const onMove = (ev) => {
      const fine = ev.shiftKey ? 0.22 : 1;
      const n = clamp(startN - ((ev.clientY - startY) / opts.sensitivity) * fine, 0, 1);
      const nv = fromNorm(n);
      if (nv !== value) {
        value = nv;
        commit();
      }
    };
    const onUp = () => {
      knob.classList.remove('dragging');
      knob.removeEventListener('pointermove', onMove);
      knob.removeEventListener('pointerup', onUp);
      knob.removeEventListener('pointercancel', onUp);
    };
    knob.addEventListener('pointermove', onMove);
    knob.addEventListener('pointerup', onUp);
    knob.addEventListener('pointercancel', onUp);
  });

  knob.addEventListener(
    'wheel',
    (e) => {
      e.preventDefault();
      const dir = e.deltaY > 0 ? -1 : 1;
      const n = clamp(toNorm(value) + dir * (e.shiftKey ? 0.004 : 0.02), 0, 1);
      value = fromNorm(n);
      commit();
    },
    { passive: false }
  );

  knob.addEventListener('keydown', (e) => {
    const big = e.shiftKey ? 0.1 : 0.02;
    let n = null;
    if (e.key === 'ArrowUp' || e.key === 'ArrowRight') n = clamp(toNorm(value) + big, 0, 1);
    if (e.key === 'ArrowDown' || e.key === 'ArrowLeft') n = clamp(toNorm(value) - big, 0, 1);
    if (e.key === 'Home') n = 0;
    if (e.key === 'End') n = 1;
    if (n !== null) {
      e.preventDefault();
      value = fromNorm(n);
      commit();
    }
  });

  knob.addEventListener('dblclick', () => {
    const def = opts.def != null ? opts.def : opts.value;
    if (def != null) {
      value = clamp(def, opts.min, opts.max);
      commit();
    }
  });

  parent.appendChild(wrap);
  render();

  return {
    el: wrap,
    get value() {
      return value;
    },
    set: (v, silent = true) => setValue(v, silent),
  };
}

/* -------------------------------------------------------- Segment-Schalter */

export function createSeg(parent, { options, value, onChange }) {
  const root = document.createElement('div');
  root.className = 'seg';
  let current = value;

  const buttons = options.map((opt) => {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'seg-btn';
    b.textContent = opt.label;
    b.title = opt.v;
    if (opt.v === current) b.classList.add('on');
    b.addEventListener('click', () => {
      current = opt.v;
      buttons.forEach((x) => x.classList.toggle('on', x === b));
      if (onChange) onChange(current);
    });
    root.appendChild(b);
    return b;
  });

  parent.appendChild(root);

  return {
    el: root,
    get value() {
      return current;
    },
    set(v) {
      current = v;
      buttons.forEach((b, i) => b.classList.toggle('on', options[i].v === v));
    },
  };
}

/* ---------------------------------------------------------------- Mod-Wheel */

export function createWheel(root, { value = 0, onChange }) {
  root.tabIndex = 0;
  root.setAttribute('role', 'slider');
  root.setAttribute('aria-label', 'Mod Wheel');
  root.setAttribute('aria-valuemin', '0');
  root.setAttribute('aria-valuemax', '1');
  const fill = root.querySelector('.wheel-fill');
  const handle = root.querySelector('.wheel-handle');
  let v = clamp(value, 0, 1);

  function render() {
    root.style.setProperty('--v', String(v));
    if (fill) fill.style.height = v * 100 + '%';
    if (handle) handle.style.bottom = `calc(${v * 100}% - 7px)`;
    root.setAttribute('aria-valuenow', v.toFixed(2));
  }

  function set(nv, fire = true) {
    v = clamp(nv, 0, 1);
    render();
    if (fire && onChange) onChange(v);
  }

  root.addEventListener('pointerdown', (e) => {
    e.preventDefault();
    root.focus();
    root.setPointerCapture(e.pointerId);
    const rect = root.getBoundingClientRect();
    set(1 - (e.clientY - rect.top) / rect.height);
    const onMove = (ev) => {
      const r = root.getBoundingClientRect();
      set(1 - (ev.clientY - r.top) / r.height);
    };
    const onUp = () => {
      root.removeEventListener('pointermove', onMove);
      root.removeEventListener('pointerup', onUp);
      root.removeEventListener('pointercancel', onUp);
    };
    root.addEventListener('pointermove', onMove);
    root.addEventListener('pointerup', onUp);
    root.addEventListener('pointercancel', onUp);
  });

  root.addEventListener(
    'wheel',
    (e) => {
      e.preventDefault();
      set(v + (e.deltaY > 0 ? -0.05 : 0.05));
    },
    { passive: false }
  );

  root.addEventListener('keydown', (e) => {
    if (e.key === 'ArrowUp' || e.key === 'ArrowRight') {
      e.preventDefault();
      set(v + 0.05);
    }
    if (e.key === 'ArrowDown' || e.key === 'ArrowLeft') {
      e.preventDefault();
      set(v - 0.05);
    }
  });

  root.addEventListener('dblclick', () => set(0));

  render();
  return { el: root, set: (nv) => set(nv, false), get value() { return v; } };
}

/* ------------------------------------------------------- Modulationsmatrix */

export function createMatrix(root, { onChange }) {
  root.innerHTML = '';
  const grid = document.createElement('div');
  grid.className = 'mx';
  grid.style.gridTemplateColumns = '108px repeat(' + DESTS.length + ', minmax(40px, 1fr))';

  const corner = document.createElement('div');
  corner.className = 'mx-corner';
  corner.innerHTML = '<span>SRC</span><span class="mx-corner-dest">DEST →</span>';
  grid.appendChild(corner);

  const destMeters = {};
  const destHeads = {};
  for (const d of DESTS) {
    const h = document.createElement('div');
    h.className = 'mx-dest';
    h.dataset.dest = d.id;
    const label = document.createElement('span');
    label.className = 'mx-dest-label';
    label.textContent = d.label;
    const led = document.createElement('i');
    led.className = 'mx-led';
    h.append(led, label);
    grid.appendChild(h);
    destMeters[d.id] = led;
    destHeads[d.id] = h;
  }

  const srcLeds = {};
  const srcHeads = {};
  const cells = [];

  for (const s of SOURCES) {
    const label = document.createElement('div');
    label.className = 'mx-src';
    label.dataset.src = s.id;
    label.style.setProperty('--c', s.color);
    const led = document.createElement('i');
    led.className = 'mx-src-led';
    const text = document.createElement('span');
    text.textContent = s.label;
    label.append(led, text);
    grid.appendChild(label);
    srcLeds[s.id] = led;
    srcHeads[s.id] = label;

    for (const d of DESTS) {
      const key = `${s.id}:${d.id}`;
      const cell = document.createElement('div');
      cell.className = 'mx-cell';
      cell.dataset.src = s.id;
      cell.dataset.dest = d.id;
      cell.dataset.key = key;
      cell.tabIndex = 0;
      cell.setAttribute('role', 'spinbutton');
      cell.setAttribute('aria-label', `${s.label} → ${d.label}`);
      cell.style.setProperty('--c', s.color);

      const val = document.createElement('span');
      val.className = 'mx-val';
      const bar = document.createElement('span');
      bar.className = 'mx-bar';
      const barFill = document.createElement('i');
      bar.appendChild(barFill);
      const glow = document.createElement('i');
      glow.className = 'mx-glow';

      cell.append(val, bar, glow);
      grid.appendChild(cell);

      const cellRef = { el: cell, val, barFill, glow, src: s.id, dest: d.id, key };
      cells.push(cellRef);

      const readAmount = () => {
        const a = state.matrix[key];
        return typeof a === 'number' ? a : 0;
      };

      const paint = () => {
        const a = readAmount();
        const n = clamp(a / 100, -1, 1);
        val.textContent = a === 0 ? '·' : (a > 0 ? '+' : '') + Math.round(a);
        cell.classList.toggle('neg', a < 0);
        cell.classList.toggle('pos', a > 0);
        if (a >= 0) {
          barFill.style.left = '50%';
          barFill.style.width = n * 50 + '%';
        } else {
          barFill.style.left = 50 + n * 50 + '%';
          barFill.style.width = -n * 50 + '%';
        }
        cell.setAttribute('aria-valuenow', String(Math.round(a)));
      };
      cellRef.paint = paint;

      const write = (a) => {
        const nv = clamp(Math.round(a), -100, 100);
        state.matrix[key] = nv;
        paint();
        if (onChange) onChange(key, nv);
      };

      cell.addEventListener('pointerdown', (e) => {
        if (e.pointerType === 'mouse' && e.button !== 0) return;
        e.preventDefault();
        cell.focus();
        cell.setPointerCapture(e.pointerId);
        const startY = e.clientY;
        const startA = readAmount();
        cell.classList.add('dragging');

        const onMove = (ev) => {
          const fine = ev.shiftKey ? 0.2 : 1;
          const a = clamp(startA - (ev.clientY - startY) * 0.9 * fine, -100, 100);
          write(a);
        };
        const onUp = () => {
          cell.classList.remove('dragging');
          cell.removeEventListener('pointermove', onMove);
          cell.removeEventListener('pointerup', onUp);
          cell.removeEventListener('pointercancel', onUp);
        };
        cell.addEventListener('pointermove', onMove);
        cell.addEventListener('pointerup', onUp);
        cell.addEventListener('pointercancel', onUp);
      });

      cell.addEventListener(
        'wheel',
        (e) => {
          e.preventDefault();
          const step = e.shiftKey ? 1 : 5;
          write(readAmount() + (e.deltaY > 0 ? -step : step));
        },
        { passive: false }
      );

      cell.addEventListener('dblclick', () => write(0));

      cell.addEventListener('keydown', (e) => {
        const step = e.shiftKey ? 1 : 5;
        if (e.key === 'ArrowUp') {
          e.preventDefault();
          write(readAmount() + step);
        } else if (e.key === 'ArrowDown') {
          e.preventDefault();
          write(readAmount() - step);
        } else if (e.key === 'Backspace' || e.key === 'Delete' || e.key === '0') {
          e.preventDefault();
          write(0);
        }
      });

      cell.addEventListener('mouseenter', () => {
        cells.forEach((c) => {
          c.el.classList.toggle('hl', c.src === s.id || c.dest === d.id);
        });
        srcHeads[s.id].classList.add('hl');
        destHeads[d.id].classList.add('hl');
      });
      cell.addEventListener('mouseleave', () => {
        cells.forEach((c) => c.el.classList.remove('hl'));
        Object.values(srcHeads).forEach((h) => h.classList.remove('hl'));
        Object.values(destHeads).forEach((h) => h.classList.remove('hl'));
      });

      paint();
    }
  }

  root.appendChild(grid);

  return {
    el: grid,
    refresh() {
      cells.forEach((c) => c.paint());
    },
    setActivity(src, sums) {
      if (!src) return;
      for (const c of cells) {
        const a = state.matrix[c.key] || 0;
        if (!a) {
          if (c.glow.style.opacity !== '0') c.glow.style.opacity = '0';
          continue;
        }
        const intensity = Math.min(1, Math.abs((src[c.src] || 0) * (a / 100)));
        c.glow.style.opacity = String(intensity);
        c.glow.style.transform = `scaleX(${Math.max(0.04, intensity)})`;
      }
      for (const d of DESTS) {
        const v = sums ? Math.abs(sums[d.id] || 0) : 0;
        destMeters[d.id].style.transform = `scaleY(${Math.min(1, v)})`;
        destMeters[d.id].style.opacity = String(0.15 + Math.min(1, v) * 0.85);
      }
      for (const s of SOURCES) {
        const v = Math.abs(src[s.id] || 0);
        srcLeds[s.id].style.transform = `scaleX(${Math.max(0.12, Math.min(1, v))})`;
        srcLeds[s.id].style.opacity = String(0.2 + Math.min(1, v) * 0.8);
      }
    },
  };
}

/* ---------------------------------------------------------------- Keyboard */

const NOTE_NAMES = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'];
const WHITE_SEMIS = [0, 2, 4, 5, 7, 9, 11];
const BLACK_OFFSETS = [
  { semi: 1, after: 0 },
  { semi: 3, after: 1 },
  { semi: 6, after: 3 },
  { semi: 8, after: 4 },
  { semi: 10, after: 5 },
];

export function noteName(n) {
  return NOTE_NAMES[((n % 12) + 12) % 12] + (Math.floor(n / 12) - 1);
}

export function createKeyboard(root, { base = 48, octaves = 2, onNoteOn, onNoteOff }) {
  let start = base;
  const held = new Map(); // pointerId -> note

  function press(note, el, velocity) {
    if (el) el.classList.add('active');
    if (onNoteOn) onNoteOn(note, velocity);
  }
  function lift(note, el) {
    if (el) el.classList.remove('active');
    if (onNoteOff) onNoteOff(note);
  }

  function build() {
    root.innerHTML = '';
    const totalWhites = WHITE_SEMIS.length * octaves;
    const whiteWidth = 100 / totalWhites;
    const blackWidth = whiteWidth * 0.62;
    let whiteIndex = 0;

    for (let o = 0; o < octaves; o++) {
      for (const semi of WHITE_SEMIS) {
        const note = start + o * 12 + semi;
        const key = document.createElement('div');
        key.className = 'key white';
        key.dataset.note = String(note);
        if (semi === 0) {
          const name = document.createElement('span');
          name.className = 'key-name';
          name.textContent = noteName(note);
          key.appendChild(name);
        }
        root.appendChild(key);
        whiteIndex++;
      }
    }

    whiteIndex = 0;
    for (let o = 0; o < octaves; o++) {
      for (const b of BLACK_OFFSETS) {
        const note = start + o * 12 + b.semi;
        const key = document.createElement('div');
        key.className = 'key black';
        key.dataset.note = String(note);
        key.style.left = (o * WHITE_SEMIS.length + b.after + 1) * whiteWidth - blackWidth / 2 + '%';
        key.style.width = blackWidth + '%';
        root.appendChild(key);
      }
    }

    root.querySelectorAll('.key').forEach((key) => {
      const note = Number(key.dataset.note);
      key.addEventListener('pointerdown', (e) => {
        e.preventDefault();
        const rect = key.getBoundingClientRect();
        const velocity = clamp(0.35 + ((e.clientY - rect.top) / rect.height) * 0.65, 0.2, 1);
        key.setPointerCapture(e.pointerId);
        held.set(e.pointerId, note);
        key.classList.add('active');
        if (onNoteOn) onNoteOn(note, velocity);
      });
      const end = (e) => {
        if (held.has(e.pointerId)) {
          held.delete(e.pointerId);
          key.classList.remove('active');
          if (onNoteOff) onNoteOff(note);
        }
      };
      key.addEventListener('pointerup', end);
      key.addEventListener('pointercancel', end);
    });
  }

  build();

  return {
    setBase(nb) {
      start = nb;
      build();
    },
    get base() {
      return start;
    },
    pressExternal(note) {
      const el = root.querySelector(`.key[data-note="${note}"]`);
      if (el) el.classList.add('active');
    },
    releaseExternal(note) {
      const el = root.querySelector(`.key[data-note="${note}"]`);
      if (el) el.classList.remove('active');
    },
    releaseAll() {
      held.clear();
      root.querySelectorAll('.key.active').forEach((k) => k.classList.remove('active'));
    },
  };
}

/* ------------------------------------------------------------------- Scope */

export class Scope {
  constructor(canvas, { engine, meterFill, stateEl, dbEl }) {
    this.canvas = canvas;
    this.engine = engine;
    this.meterFill = meterFill;
    this.stateEl = stateEl;
    this.dbEl = dbEl;
    this.g = canvas.getContext('2d');
    this.buf = new Float32Array(2048);
    this.dpr = 1;
    this.resize();
    if (window.ResizeObserver) {
      this.ro = new ResizeObserver(() => this.resize());
      this.ro.observe(canvas);
    }
  }

  resize() {
    const rect = this.canvas.getBoundingClientRect();
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    this.dpr = dpr;
    this.w = Math.max(2, Math.round(rect.width));
    this.h = Math.max(2, Math.round(rect.height));
    this.canvas.width = Math.round(this.w * dpr);
    this.canvas.height = Math.round(this.h * dpr);
    this.g.setTransform(dpr, 0, 0, dpr, 0, 0);
  }

  draw() {
    const g = this.g;
    const w = this.w;
    const h = this.h;
    g.clearRect(0, 0, w, h);

    /* Raster */
    g.strokeStyle = 'rgba(150, 175, 205, 0.09)';
    g.lineWidth = 1;
    g.beginPath();
    for (let i = 1; i < 8; i++) {
      const x = Math.round((w * i) / 8) + 0.5;
      g.moveTo(x, 0);
      g.lineTo(x, h);
    }
    for (let j = 1; j < 4; j++) {
      const y = Math.round((h * j) / 4) + 0.5;
      g.moveTo(0, y);
      g.lineTo(w, y);
    }
    g.stroke();

    g.strokeStyle = 'rgba(150, 175, 205, 0.18)';
    g.beginPath();
    g.moveTo(0, h / 2 + 0.5);
    g.lineTo(w, h / 2 + 0.5);
    g.stroke();

    const an = this.engine.analyser;
    if (!an) {
      g.fillStyle = 'rgba(127, 140, 156, 0.45)';
      g.font = '600 11px ui-monospace, Menlo, monospace';
      g.textAlign = 'left';
      g.fillText('AUDIO OFF — START DRÜCKEN', 10, h / 2 - 8);
      if (this.stateEl) this.stateEl.textContent = 'AUDIO OFF';
      if (this.dbEl) this.dbEl.textContent = '−∞ dB';
      if (this.meterFill) this.meterFill.style.width = '0%';
      return;
    }

    if (this.buf.length !== an.fftSize) this.buf = new Float32Array(an.fftSize);
    an.getFloatTimeDomainData(this.buf);
    const buf = this.buf;

    let rms = 0;
    for (let i = 0; i < buf.length; i++) rms += buf[i] * buf[i];
    rms = Math.sqrt(rms / buf.length);

    /* Trigger-Suche für stabiles Bild */
    let startIdx = 0;
    const searchEnd = Math.floor(buf.length * 0.4);
    for (let i = 1; i < searchEnd; i++) {
      if (buf[i - 1] <= 0 && buf[i] > 0) {
        startIdx = i;
        break;
      }
    }
    const span = Math.floor(buf.length * 0.55);

    const grad = g.createLinearGradient(0, 0, w, 0);
    grad.addColorStop(0, '#ff7a29');
    grad.addColorStop(0.5, '#ffb245');
    grad.addColorStop(1, '#54d7c7');
    g.strokeStyle = grad;
    g.lineWidth = 1.7;
    g.lineJoin = 'round';
    g.shadowColor = 'rgba(255, 178, 69, 0.45)';
    g.shadowBlur = 10;
    g.beginPath();
    for (let i = 0; i < span; i++) {
      const v = buf[startIdx + i] || 0;
      const x = (i / (span - 1)) * w;
      const y = h / 2 - v * (h * 0.46);
      if (i === 0) g.moveTo(x, y);
      else g.lineTo(x, y);
    }
    g.stroke();
    g.shadowBlur = 0;

    const db = rms > 0.00001 ? 20 * Math.log10(rms) : -Infinity;
    const norm = clamp((db + 54) / 54, 0, 1);
    if (this.meterFill) this.meterFill.style.width = Math.round(norm * 100) + '%';
    if (this.dbEl) this.dbEl.textContent = db === -Infinity ? '−∞ dB' : db.toFixed(1) + ' dB';
    if (this.stateEl) {
      this.stateEl.textContent = rms > 0.002 ? 'SIGNAL' : 'IDLE';
    }
  }
}

/* -------------------------------------------------------------- LFO-Preview */

const shapeAt = (shape, p) => {
  switch (shape) {
    case 'sine':
      return Math.sin(p * Math.PI * 2);
    case 'tri':
      return 1 - 4 * Math.abs(((p + 0.25) % 1) - 0.5);
    case 'saw':
      return 2 * p - 1;
    case 'square':
      return p < 0.5 ? 1 : -1;
    case 'random':
      return p < 0.5 ? 0.55 : -0.55;
    default:
      return 0;
  }
};

export class LfoPreview {
  constructor(canvas, engine, which, color) {
    this.canvas = canvas;
    this.g = canvas.getContext('2d');
    this.engine = engine;
    this.which = which;
    this.color = color;
    this.w = 1;
    this.h = 1;
    this.dpr = 1;
    this.resize();
    if (window.ResizeObserver) {
      this.ro = new ResizeObserver(() => this.resize());
      this.ro.observe(canvas);
    }
  }

  resize() {
    const rect = this.canvas.getBoundingClientRect();
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    this.dpr = dpr;
    this.w = Math.max(2, rect.width);
    this.h = Math.max(2, rect.height);
    this.canvas.width = Math.round(this.w * dpr);
    this.canvas.height = Math.round(this.h * dpr);
    this.g.setTransform(dpr, 0, 0, dpr, 0, 0);
  }

  draw() {
    const g = this.g;
    const w = this.w;
    const h = this.h;
    const is1 = this.which === 'lfo1';
    const shape = is1 ? state.lfo1.shape : state.lfo2.shape;
    const phase = is1 ? this.engine.lfo1.phase : this.engine.lfo2.phase;
    const rate = is1 ? this.engine.lfoRate.lfo1 : this.engine.lfoRate.lfo2;

    g.clearRect(0, 0, w, h);
    g.strokeStyle = 'rgba(150, 175, 205, 0.16)';
    g.lineWidth = 1;
    g.beginPath();
    g.moveTo(0, h / 2 + 0.5);
    g.lineTo(w, h / 2 + 0.5);
    g.stroke();

    const cycles = 2;
    const points = 120;
    g.beginPath();
    for (let i = 0; i <= points; i++) {
      const p = (i / points) * cycles;
      const v = shapeAt(shape, p % 1);
      const x = (i / points) * w;
      const y = h / 2 - v * (h * 0.4);
      if (i === 0) g.moveTo(x, y);
      else g.lineTo(x, y);
    }
    g.strokeStyle = this.color;
    g.globalAlpha = 0.55;
    g.lineWidth = 1.4;
    g.stroke();
    g.globalAlpha = 1;

    const px = (phase % 1) * (w / cycles);
    const pv = shapeAt(shape, phase % 1);
    const py = h / 2 - pv * (h * 0.4);
    g.beginPath();
    g.arc(px, py, 3, 0, Math.PI * 2);
    g.fillStyle = this.color;
    g.shadowColor = this.color;
    g.shadowBlur = 8;
    g.fill();
    g.shadowBlur = 0;

    g.fillStyle = 'rgba(200, 215, 230, 0.7)';
    g.font = '600 9px ui-monospace, Menlo, monospace';
    g.textAlign = 'right';
    g.fillText(rate < 10 ? rate.toFixed(2) + ' Hz' : Math.round(rate) + ' Hz', w - 2, 10);
  }
}
