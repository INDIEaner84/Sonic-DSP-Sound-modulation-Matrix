/* Sonic DSP — Clip / Loop-Inhalt
 * Aufnahme von Noten-Events (kein Audio!): Tick-Position, Dauer, Velocity.
 * Aufnahme erfolgt in „Takes" – ein Take = ein Durchgang, Undo entfernt den letzten.
 */

let takeSeq = 0;
const nextTakeId = () => `t${Date.now().toString(36)}-${(takeSeq++).toString(36)}`;

export class Clip {
  constructor() {
    this.takes = [];
    this._take = null;
    this._open = new Map(); // note -> event (noch nicht losgelassen)
  }

  get events() {
    const out = [];
    for (const take of this.takes) for (const ev of take.events) out.push(ev);
    return out;
  }

  get count() {
    let n = 0;
    for (const take of this.takes) n += take.events.length;
    return n;
  }

  get takeCount() {
    return this.takes.length;
  }

  get isRecording() {
    return this._take !== null;
  }

  beginTake() {
    this.closeOpen(null);
    this._take = { id: nextTakeId(), events: [] };
    this.takes.push(this._take);
    return this._take;
  }

  endTake(loopTicks) {
    if (!this._take) return;
    this.closeOpen(loopTicks);
    this._take = null;
  }

  /** @param {number} tick quantisierte Position im Loop */
  startNote(note, vel, tick) {
    if (!this._take) return null;
    const prev = this._open.get(note);
    if (prev) prev.dur = Math.max(1, tick - prev.tick);
    const ev = { tick, dur: 0, note, vel, take: this._take.id };
    this._take.events.push(ev);
    this._open.set(note, ev);
    return ev;
  }

  endNote(note, tick, loopTicks) {
    const ev = this._open.get(note);
    if (!ev) return;
    let dur = tick - ev.tick;
    if (dur <= 0) dur = loopTicks - ev.tick;
    ev.dur = Math.max(1, Math.round(dur));
    this._open.delete(note);
  }

  /** Offene Noten schließen (Loop-Ende / Aufnahme-Stopp). */
  closeOpen(loopTicks) {
    for (const ev of this._open.values()) {
      ev.dur = ev.dur > 0 ? ev.dur : Math.max(1, loopTicks ? loopTicks - ev.tick : 1);
    }
    this._open.clear();
  }

  undo() {
    if (!this.takes.length) return false;
    const removed = this.takes.pop();
    for (const [note, ev] of [...this._open]) {
      if (ev.take === removed.id) this._open.delete(note);
    }
    if (this._take === removed) this._take = null;
    return true;
  }

  clear() {
    this.takes = [];
    this._open.clear();
    this._take = null;
  }

  /** Import: Events als ein Take übernehmen. */
  addEvents(events) {
    if (!events || !events.length) return null;
    const take = { id: nextTakeId(), events: [] };
    for (const e of events) {
      take.events.push({ tick: e.tick, dur: e.dur, note: e.note, vel: e.vel, take: take.id });
    }
    this.takes.push(take);
    return take;
  }

  /** Serialisierung: pro Take ein Array aus schlichten Event-Objekten. */
  toTakes() {
    return this.takes.map((take) =>
      take.events.map((ev) => ({ tick: ev.tick, dur: ev.dur, note: ev.note, vel: ev.vel }))
    );
  }

  static fromTakes(takes) {
    const clip = new Clip();
    if (!Array.isArray(takes)) return clip;
    for (const events of takes) {
      if (!Array.isArray(events) || !events.length) continue;
      clip.addEvents(events);
    }
    return clip;
  }

  /** Events eines Zeitfensters – inkl. Swing-Verschiebung. */
  eventsInWindow(from, to, secPerTick, swingOffset) {
    if (!this.takes.length) return [];
    const out = [];
    for (const take of this.takes) {
      for (const ev of take.events) {
        if (ev.dur <= 0) continue;
        const t = ev.tick * secPerTick + swingOffset(ev.tick);
        if (t >= from && t < to) out.push({ ev, t });
      }
    }
    out.sort((a, b) => a.t - b.t);
    return out;
  }
}
