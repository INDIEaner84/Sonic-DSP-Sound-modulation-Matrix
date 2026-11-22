/* Sonic DSP — Transport & Clock
 * Lookahead-Scheduler über alle Spuren des Projekts. Zeitbasis ist
 * ausschließlich AudioContext.currentTime; Noten werden ~120 ms im Voraus
 * geplant (kein rAF, kein nacktes setInterval für Noten).
 */

import { trackAudible, activeTrackOf, loopTicksOf, PPQ, BEATS_PER_BAR, LIMITS } from './project.js';

export { PPQ, BEATS_PER_BAR };

const LOOKAHEAD_MS = 25;
const SCHEDULE_AHEAD = 0.12;

export class Clock {
  constructor(engine, project) {
    this.engine = engine;
    this.project = project;

    this.running = false;
    this.recording = false;

    this.loopStart = 0;
    this._scheduledUntil = 0;
    this._timer = null;
    this._live = new Map(); // `${trackId}:${note}` -> [voices]
    this._listeners = [];
  }

  /* -------------------------------------------------------------- Zeitbasis */

  get bpm() {
    return this.project.bpm;
  }

  get bars() {
    return this.project.bars;
  }

  get metronome() {
    return this.project.metronome;
  }

  get quantizeStep() {
    return this.project.quantizeStep;
  }

  get swing() {
    return this.project.swing;
  }

  get secPerBeat() {
    return 60 / this.project.bpm;
  }

  get secPerTick() {
    return this.secPerBeat / PPQ;
  }

  get loopTicks() {
    return loopTicksOf(this.project);
  }

  get loopDur() {
    return this.loopTicks * this.secPerTick;
  }

  get stepDur() {
    return this.project.quantizeStep * this.secPerTick;
  }

  get ctx() {
    return this.engine.ctx;
  }

  get activeTrack() {
    return activeTrackOf(this.project);
  }

  onChange(cb) {
    this._listeners.push(cb);
  }

  emit() {
    for (const cb of this._listeners) cb(this);
  }

  setProject(project) {
    this.project = project;
  }

  /* ---------------------------------------------------------------- Steuerung */

  start({ countIn = false, record = false } = {}) {
    if (!this.ctx) return false;
    const now = this.ctx.currentTime;
    const pre = countIn ? this.secPerBeat * BEATS_PER_BAR : 0.06;

    this.loopStart = now + pre;
    this._scheduledUntil = now;
    this.running = true;
    this.recording = false;
    for (const t of this.project.tracks) t.clip.closeOpen(this.loopTicks);

    if (countIn && this.metronome) this._scheduleCountIn(now, pre);
    if (record) this.beginRecording();

    this._startTimer();
    this.emit();
    return true;
  }

  stop() {
    for (const t of this.project.tracks) t.clip.endTake(this.loopTicks);
    this.running = false;
    this.recording = false;
    this._live.clear();
    if (this._timer) {
      clearInterval(this._timer);
      this._timer = null;
    }
    this.engine.allNotesOff();
    this.emit();
  }

  toggle() {
    if (this.running) this.stop();
    else this.start({ countIn: false });
    return this.running;
  }

  /** Take entsteht erst mit der ersten Note – kein leerer Take beim Arming. */
  beginRecording() {
    this.recording = true;
    this.emit();
  }

  endRecording() {
    this.recording = false;
    for (const t of this.project.tracks) t.clip.endTake(this.loopTicks);
    this.emit();
  }

  toggleRecord() {
    if (!this.ctx) return;
    if (this.recording) {
      this.endRecording();
      return;
    }
    if (!this.running) this.start({ countIn: true, record: true });
    else this.beginRecording();
  }

  setBpm(bpm) {
    const v = Math.max(LIMITS.minBpm, Math.min(LIMITS.maxBpm, Math.round(bpm)));
    if (v === this.project.bpm) return;
    const now = this.ctx ? this.ctx.currentTime : 0;
    /* Tick-Position ist die Invariante, nicht die Phase (sich ändernde Loop-Dauer). */
    const ticks = this.running ? this.position().ticks : 0;
    this.project.bpm = v;
    if (this.running) this.loopStart = now - ticks * this.secPerTick;
    this.emit();
  }

  setBars(bars) {
    const n = Math.max(LIMITS.minBars, Math.min(LIMITS.maxBars, Math.round(bars)));
    if (n === this.project.bars) return;
    const now = this.ctx ? this.ctx.currentTime : 0;
    const ticks = this.running ? this.position().ticks : 0;
    const oldLoop = this.loopTicks;
    this.project.bars = n;
    if (this.running) {
      const kept = oldLoop > 0 ? ticks % this.loopTicks : 0;
      this.loopStart = now - kept * this.secPerTick;
    }
    this.emit();
  }

  setQuantize(ticks) {
    this.project.quantizeStep = Math.max(0, Math.round(ticks));
    this.emit();
  }

  setSwing(v) {
    this.project.swing = Math.max(0, Math.min(0.6, v));
  }

  setMetronome(on) {
    this.project.metronome = !!on;
    this.emit();
  }

  /* ------------------------------------------------------------------ Timing */

  _startTimer() {
    if (this._timer) return;
    this._timer = setInterval(() => this.pump(), LOOKAHEAD_MS);
  }

  /** Plant alle Noten/Klicks im Fenster [jetzt, jetzt + 120 ms]. */
  pump() {
    const ctx = this.ctx;
    if (!ctx || !this.running) return;
    const now = ctx.currentTime;
    const until = now + SCHEDULE_AHEAD;

    if (this._scheduledUntil < now - 0.25) this._scheduledUntil = now; // Tab war inaktiv
    const from = this._scheduledUntil;
    if (until <= from) return;

    this._scheduleNotes(from, until);
    this._scheduleMetronome(from, until);
    this._scheduledUntil = until;
  }

  swingOffset(tick) {
    if (!this.swing || !this.project.quantizeStep) return 0;
    const idx = Math.round(tick / this.project.quantizeStep);
    return idx % 2 ? this.swing * this.stepDur : 0;
  }

  _scheduleNotes(from, to) {
    if (to <= this.loopStart) return;
    const start = Math.max(from, this.loopStart);
    const dur = this.loopDur;
    if (dur <= 0) return;

    const first = Math.floor((start - this.loopStart) / dur);
    const last = Math.floor((to - this.loopStart) / dur);

    for (const track of this.project.tracks) {
      if (!track.clip || !track.clip.takes.length) continue;
      if (!trackAudible(track, this.project.tracks)) continue;

      for (let k = first; k <= last; k++) {
        const base = this.loopStart + k * dur;
        const w0 = Math.max(0, start - base);
        const w1 = Math.min(dur, to - base);
        if (w1 <= 0) continue;

        for (const { ev, t } of track.clip.eventsInWindow(w0, w1, this.secPerTick, (tick) => this.swingOffset(tick))) {
          const when = base + t;
          const voice = this.engine.noteOn(track.id, ev.note, ev.vel, when);
          if (voice) this.engine.scheduleRelease(voice, when + Math.max(0.03, ev.dur * this.secPerTick));
        }
      }
    }
  }

  _scheduleMetronome(from, to) {
    if (!this.metronome) return;
    if (to <= this.loopStart) return;
    const start = Math.max(from, this.loopStart);
    const beat = this.secPerBeat;
    const first = Math.ceil((start - this.loopStart) / beat - 1e-6);
    const last = Math.floor((to - this.loopStart) / beat + 1e-6);
    for (let b = Math.max(0, first); b <= last; b++) {
      const when = this.loopStart + b * beat;
      if (when < from - 1e-6) continue;
      this.engine.click(when, b % BEATS_PER_BAR === 0);
    }
  }

  _scheduleCountIn(from, pre) {
    const beat = this.secPerBeat;
    const n = Math.max(1, Math.round(pre / beat));
    for (let i = 0; i < n; i++) this.engine.click(from + i * beat, i % BEATS_PER_BAR === 0);
  }

  /* -------------------------------------------------------------- Position */

  currentTicks() {
    const ctx = this.ctx;
    if (!ctx || !this.running) return 0;
    let t = ctx.currentTime - this.loopStart;
    if (t < 0) return 0;
    const dur = this.loopDur;
    if (t >= dur) t %= dur;
    return t / this.secPerTick;
  }

  quantized(ticks) {
    const loop = this.loopTicks;
    if (!this.project.quantizeStep) {
      let t = Math.round(ticks) % loop;
      return t < 0 ? t + loop : t;
    }
    let q = Math.round(ticks / this.project.quantizeStep) * this.project.quantizeStep;
    q %= loop;
    return q < 0 ? q + loop : q;
  }

  position() {
    const idle = {
      running: false,
      counting: false,
      phase: 0,
      ticks: 0,
      bar: 1,
      beat: 1,
      sixteenth: 1,
      loopIndex: 0,
      countdown: 0,
    };
    const ctx = this.ctx;
    if (!ctx || !this.running) return idle;

    const t = ctx.currentTime - this.loopStart;
    if (t < 0) {
      return { ...idle, running: true, counting: true, countdown: Math.ceil(-t / this.secPerBeat) };
    }
    const dur = this.loopDur;
    const loopIndex = Math.floor(t / dur);
    const inLoop = t - loopIndex * dur;
    const ticks = inLoop / this.secPerTick;
    const bar = Math.floor(ticks / (BEATS_PER_BAR * PPQ)) + 1;
    const beat = Math.floor((ticks % (BEATS_PER_BAR * PPQ)) / PPQ) + 1;
    const sixteenth = Math.floor((ticks % PPQ) / (PPQ / 4)) + 1;
    return {
      running: true,
      counting: false,
      phase: inLoop / dur,
      ticks,
      bar,
      beat,
      sixteenth,
      loopIndex,
      countdown: 0,
    };
  }

  /* ---------------------------------------------------------- Live-Spiel */

  noteOn(note, velocity = 0.85) {
    const ctx = this.ctx;
    const track = this.activeTrack;
    if (!ctx || !track) return null;

    const voice = this.engine.noteOn(track.id, note, velocity, null);
    if (voice) {
      const key = `${track.id}:${note}`;
      const list = this._live.get(key) || [];
      list.push(voice);
      this._live.set(key, list);
    }

    if (this.recording && this.running && ctx.currentTime >= this.loopStart) {
      if (!track.clip.isRecording) track.clip.beginTake();
      const tick = this.quantized(this.currentTicks());
      track.clip.startNote(note, velocity, tick);
    }
    return voice;
  }

  noteOff(note) {
    const track = this.activeTrack;
    if (!track) return;
    const key = `${track.id}:${note}`;
    const list = this._live.get(key);
    if (list && list.length) {
      const now = this.ctx ? this.ctx.currentTime : 0;
      for (const v of list) v.release(now);
      this._live.delete(key);
    } else {
      this.engine.noteOff(track.id, note);
    }

    if (this.recording && this.running && this.ctx && this.ctx.currentTime >= this.loopStart) {
      const tick = this.quantized(this.currentTicks());
      track.clip.endNote(note, tick, this.loopTicks);
    }
  }

  /** Live-Stimmen sofort freigeben (Loop-Wiedergabe läuft weiter). */
  releaseLive() {
    const now = this.ctx ? this.ctx.currentTime : 0;
    for (const list of this._live.values()) for (const v of list) v.release(now);
    this._live.clear();
  }

  /** Alles aus: Live-Noten + geplante Stimmen. */
  panic() {
    this._live.clear();
    this.engine.allNotesOff();
  }

  undo() {
    const track = this.activeTrack;
    const ok = track ? track.clip.undo() : false;
    this.emit();
    return ok;
  }

  clearClip() {
    const track = this.activeTrack;
    if (track) track.clip.clear();
    this.emit();
  }
}
