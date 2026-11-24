/* SF2-Parser (SoundFont 2) — eigene Implementierung, keine Fremdbibliothek.
 *
 * Ziel: eine vom Nutzer gewählte .sf2-Datei im Browser lesen und daraus
 * spielbare Zonen (Key-/Velocity-Bereich, Grundton, Loop, Pegel) gewinnen.
 * Der Parser macht **kein** Audio: er liefert Metadaten und die PCM-Rohdaten,
 * die eine Stimme (SampleVoice) später in AudioBuffers übersetzt.
 *
 * Bewusst klein gehalten:
 * - 16-Bit-PCM (Standard-SF2). `sm24` (24 Bit) wird erkannt und gemeldet,
 *   aber nicht ausgewertet.
 * - Keine Modulatoren, keine Filter-Hüllkurven, keine Effekt-Sends aus der Datei.
 *   Diese Aufgabe bleibt bei der Engine (Drive, Sends, Pan, Filter je Spur).
 * - Streng bei Struktur (RIFF/Chunks/Bereiche), tolerant bei Details: was
 *   fehlt, wird als Standard angenommen und als Warnung gemeldet.
 *
 * Format-Referenz: SoundFont Technical Specification 2.04 (Creative/E-mu).
 */

export const SF2_LIMITS = {
  maxBytes: 64 * 1024 * 1024, // größere Dateien sprengen den Browser-Speicher
  maxPresets: 512,
  maxZones: 8192,
};

/* Generator-IDs nach SF2-Spezifikation (nur die, die wir nutzen). */
const GEN = {
  startAddrsOffset: 0,
  endAddrsOffset: 1,
  startLoopAddrsOffset: 2,
  endLoopAddrsOffset: 3,
  startAddrsCoarseOffset: 4,
  pan: 17,
  attackVolEnv: 34,
  releaseVolEnv: 38,
  instrument: 41,
  keyRange: 43,
  velRange: 44,
  startLoopAddrsCoarseOffset: 45,
  initialAttenuation: 48,
  endLoopAddrsCoarseOffset: 50,
  coarseTune: 51,
  fineTune: 52,
  sampleID: 53,
  sampleModes: 54,
  overridingRootKey: 58,
};

const RECORD = {
  phdr: 38,
  pbag: 4,
  pmod: 10,
  pgen: 4,
  inst: 22,
  ibag: 4,
  imod: 10,
  igen: 4,
  shdr: 46,
};

/* ------------------------------------------------------------- Byte-Helfer */

function fourcc(bytes, at) {
  return String.fromCharCode(bytes[at], bytes[at + 1], bytes[at + 2], bytes[at + 3]);
}

function clampInt(value, min, max) {
  return Math.max(min, Math.min(max, value));
}

function readName(bytes, at, length) {
  let out = '';
  for (let i = 0; i < length; i++) {
    const code = bytes[at + i];
    if (!code) break;
    out += String.fromCharCode(code);
  }
  return out.replace(/\s+/g, ' ').trim();
}

/** Wandelt beliebige Eingaben (ArrayBuffer/Uint8Array) in eine Byte-Sicht. */
function toBytes(input) {
  if (input instanceof Uint8Array) return input;
  if (input instanceof ArrayBuffer) return new Uint8Array(input);
  if (ArrayBuffer.isView(input)) return new Uint8Array(input.buffer, input.byteOffset, input.byteLength);
  return null;
}

/* ---------------------------------------------------------------- RIFF-Baum */

/**
 * Liest eine Chunk-Liste im Bereich [start, end). Jeder Chunk hat einen
 * 8-Byte-Kopf (ID + Größe, little endian) und wird auf 2 Byte gepolstert.
 */
function readChunks(bytes, start, end, errors, path) {
  const chunks = [];
  let at = start;
  while (at + 8 <= end) {
    const id = fourcc(bytes, at);
    const size = (bytes[at + 4] | (bytes[at + 5] << 8) | (bytes[at + 6] << 16) | (bytes[at + 7] << 24)) >>> 0;
    const dataStart = at + 8;
    const dataEnd = dataStart + size;
    if (dataEnd > end) {
      errors.push(`${path}: Chunk „${id}" ragt über das Dateiende (${size} Byte)`);
      return chunks;
    }
    chunks.push({ id, start: dataStart, end: dataEnd });
    at = dataEnd + (size & 1);
  }
  return chunks;
}

function chunkOf(chunks, id) {
  return chunks.find((c) => c.id === id) || null;
}

/* ------------------------------------------------------------------- INFO */

function parseInfo(bytes, chunk) {
  const info = { name: '', author: '', copyright: '', software: '', comments: '' };
  if (!chunk) return info;
  const map = { INAM: 'name', IENG: 'author', ICOP: 'copyright', ISFT: 'software', ICMT: 'comments' };
  const subs = readChunks(bytes, chunk.start, chunk.end, [], 'INFO');
  for (const sub of subs) {
    const key = map[sub.id];
    if (!key) continue;
    info[key] = readName(bytes, sub.start, sub.end - sub.start);
  }
  return info;
}

/* ------------------------------------------------------------------- pdta */

/* Die pdta-Records haben unterschiedliche Feldreihenfolgen, deshalb eigene Leser. */
function readPresetHeaders(bytes, chunk, errors) {
  const out = [];
  if (!chunk) return out;
  const count = Math.floor((chunk.end - chunk.start) / RECORD.phdr);
  for (let i = 0; i < count; i++) {
    const at = chunk.start + i * RECORD.phdr;
    out.push({
      name: readName(bytes, at, 20),
      program: bytes[at + 20] | (bytes[at + 21] << 8),
      bank: bytes[at + 22] | (bytes[at + 23] << 8),
      bagIndex: bytes[at + 24] | (bytes[at + 25] << 8),
    });
  }
  if (!out.length) errors.push('pdta.phdr: keine Presets');
  return out;
}

function readInstrumentHeaders(bytes, chunk) {
  const out = [];
  if (!chunk) return out;
  const count = Math.floor((chunk.end - chunk.start) / RECORD.inst);
  for (let i = 0; i < count; i++) {
    const at = chunk.start + i * RECORD.inst;
    out.push({ name: readName(bytes, at, 20), bagIndex: bytes[at + 20] | (bytes[at + 21] << 8) });
  }
  return out;
}

function readBags(bytes, chunk, size) {
  const out = [];
  if (!chunk) return out;
  const count = Math.floor((chunk.end - chunk.start) / size);
  for (let i = 0; i < count; i++) {
    const at = chunk.start + i * size;
    out.push({
      genIndex: bytes[at] | (bytes[at + 1] << 8),
      modIndex: bytes[at + 2] | (bytes[at + 3] << 8),
    });
  }
  return out;
}

function readGens(bytes, chunk) {
  const out = [];
  if (!chunk) return out;
  const count = Math.floor((chunk.end - chunk.start) / RECORD.pgen);
  for (let i = 0; i < count; i++) {
    const at = chunk.start + i * RECORD.pgen;
    out.push({
      oper: bytes[at] | (bytes[at + 1] << 8),
      amount: bytes[at + 2] | (bytes[at + 3] << 8),
      low: bytes[at + 2],
      high: bytes[at + 3],
    });
  }
  return out;
}

function readSampleHeaders(bytes, chunk, errors) {
  const out = [];
  if (!chunk) return out;
  const count = Math.floor((chunk.end - chunk.start) / RECORD.shdr);
  for (let i = 0; i < count; i++) {
    const at = chunk.start + i * RECORD.shdr;
    const u32 = (o) =>
      (bytes[at + o] | (bytes[at + o + 1] << 8) | (bytes[at + o + 2] << 16) | (bytes[at + o + 3] << 24)) >>> 0;
    out.push({
      name: readName(bytes, at, 20),
      start: u32(20),
      end: u32(24),
      startLoop: u32(28),
      endLoop: u32(32),
      sampleRate: u32(36),
      originalPitch: bytes[at + 40],
      pitchCorrection: (bytes[at + 41] << 24) >> 24,
      sampleLink: bytes[at + 42] | (bytes[at + 43] << 8),
      sampleType: bytes[at + 44] | (bytes[at + 45] << 8),
    });
  }
  /* Der letzte Record ist laut Spezifikation ein Abschluss-Record („EOS"). */
  const terminal = out[out.length - 1];
  if (terminal && terminal.start === 0 && terminal.end === 0 && terminal.sampleRate === 0) out.pop();
  if (!out.length) errors.push('pdta.shdr: keine Samples');
  return out;
}

/* --------------------------------------------------------------- Zonen-Bau */

const DEFAULT_ZONE = {
  keyLow: 0,
  keyHigh: 127,
  velLow: 0,
  velHigh: 127,
  rootKey: 60,
  coarseTune: 0,
  fineTune: 0,
  attenuation: 0,
  pan: 0,
  loop: false,
  attack: -12000,
  release: -12000,
};

/** Wendet eine Generator-Liste auf eine Zone an (spätere Werte gewinnen). */
function applyGens(zone, gens, errors, path) {
  for (const gen of gens) {
    switch (gen.oper) {
      case GEN.keyRange:
        zone.keyLow = clampInt(gen.low, 0, 127);
        zone.keyHigh = clampInt(gen.high, 0, 127);
        if (zone.keyLow > zone.keyHigh) {
          errors.push(`${path}: keyRange ${zone.keyLow}…${zone.keyHigh} ist leer`);
        }
        break;
      case GEN.velRange:
        zone.velLow = clampInt(gen.low, 0, 127);
        zone.velHigh = clampInt(gen.high, 0, 127);
        if (zone.velLow > zone.velHigh) {
          errors.push(`${path}: velRange ${zone.velLow}…${zone.velHigh} ist leer`);
        }
        break;
      case GEN.overridingRootKey:
        zone.rootKey = clampInt(gen.amount, 0, 127);
        break;
      case GEN.coarseTune:
        zone.coarseTune = (gen.amount << 16) >> 16;
        break;
      case GEN.fineTune:
        zone.fineTune = (gen.amount << 16) >> 16;
        break;
      case GEN.initialAttenuation:
        zone.attenuation = gen.amount; // in 0,1 dB
        break;
      case GEN.pan:
        zone.pan = clampInt((gen.amount << 16) >> 16, -500, 500); // -50 % … +50 %
        break;
      case GEN.sampleModes:
        zone.loop = (gen.amount & 3) === 1;
        break;
      case GEN.attackVolEnv:
        zone.attack = gen.amount; // Zeitcents
        break;
      case GEN.releaseVolEnv:
        zone.release = gen.amount;
        break;
      default:
        break;
    }
  }
  return zone;
}

function genRange(gens, bag, nextBag) {
  if (!bag) return [];
  const from = bag.genIndex;
  const to = nextBag ? nextBag.genIndex : gens.length;
  if (from > to || to > gens.length) return [];
  return gens.slice(from, to);
}

function firstGenValue(gens, oper) {
  const found = gens.find((g) => g.oper === oper);
  return found ? found.amount : null;
}

/* --------------------------------------------------------------- Öffentlich */

/**
 * Liest eine SF2-Datei.
 * @returns {{ok: boolean, errors: string[], warnings: string[], soundfont: object|null}}
 */
export function parseSf2(input, { maxBytes = SF2_LIMITS.maxBytes } = {}) {
  const errors = [];
  const warnings = [];
  const bytes = toBytes(input);
  if (!bytes) {
    return { ok: false, errors: ['sf2: ArrayBuffer oder Uint8Array erwartet'], warnings, soundfont: null };
  }
  if (!bytes.length) return { ok: false, errors: ['sf2: Datei ist leer'], warnings, soundfont: null };
  if (bytes.length > maxBytes) {
    return {
      ok: false,
      errors: [`sf2: Datei ist größer als ${Math.round(maxBytes / (1024 * 1024))} MB`],
      warnings,
      soundfont: null,
    };
  }
  if (bytes.length < 12 || fourcc(bytes, 0) !== 'RIFF') {
    return { ok: false, errors: ['sf2: RIFF-Kopf fehlt'], warnings, soundfont: null };
  }
  if (fourcc(bytes, 8) !== 'sfbk') {
    return { ok: false, errors: ['sf2: Formtyp „sfbk" erwartet'], warnings, soundfont: null };
  }
  const riffSize = (bytes[4] | (bytes[5] << 8) | (bytes[6] << 16) | (bytes[7] << 24)) >>> 0;
  const riffEnd = Math.min(bytes.length, 8 + riffSize);
  if (8 + riffSize > bytes.length) {
    warnings.push('sf2: RIFF-Größe größer als die Datei, Rest wird ignoriert');
  }

  const top = readChunks(bytes, 12, riffEnd, errors, 'sf2');
  const lists = top.filter((c) => c.id === 'LIST');
  const listType = (chunk) => (chunk ? fourcc(bytes, chunk.start) : null);

  const infoChunk = lists.find((c) => listType(c) === 'INFO');
  const sdtaList = lists.find((c) => listType(c) === 'sdta');
  const pdtaList = lists.find((c) => listType(c) === 'pdta');
  if (!pdtaList) errors.push('sf2: LIST „pdta" fehlt (Instrumente/Samples)');
  if (!sdtaList) errors.push('sf2: LIST „sdta" fehlt (PCM-Daten)');

  const info = parseInfo(bytes, infoChunk ? { start: infoChunk.start + 4, end: infoChunk.end } : null);

  let smpl = null;
  let sm24 = null;
  if (sdtaList) {
    const subs = readChunks(bytes, sdtaList.start + 4, sdtaList.end, errors, 'sdta');
    smpl = chunkOf(subs, 'smpl');
    sm24 = chunkOf(subs, 'sm24');
    if (sm24) warnings.push('sf2: 24-Bit-Samples (sm24) werden ignoriert, 16 Bit wird verwendet');
    if (!smpl) errors.push('sdta: Chunk „smpl" fehlt');
  }

  let pdta = {};
  if (pdtaList) {
    const subs = readChunks(bytes, pdtaList.start + 4, pdtaList.end, errors, 'pdta');
    for (const id of Object.keys(RECORD)) {
      const chunk = chunkOf(subs, id);
      if (!chunk) {
        errors.push(`pdta: Chunk „${id}" fehlt`);
        continue;
      }
      pdta[id] = chunk;
    }
  }

  if (errors.length) return { ok: false, errors, warnings, soundfont: null };

  const presets = readPresetHeaders(bytes, pdta.phdr, errors);
  const instruments = readInstrumentHeaders(bytes, pdta.inst);
  const pbag = readBags(bytes, pdta.pbag, RECORD.pbag);
  const ibag = readBags(bytes, pdta.ibag, RECORD.ibag);
  const pgen = readGens(bytes, pdta.pgen);
  const igen = readGens(bytes, pdta.igen);
  const shdr = readSampleHeaders(bytes, pdta.shdr, errors);

  if (presets.length > SF2_LIMITS.maxPresets) errors.push(`sf2: mehr als ${SF2_LIMITS.maxPresets} Presets`);
  if (!instruments.length) errors.push('pdta.inst: keine Instrumente');
  if (presets.length && pbag.length < 2) errors.push('pdta.pbag: Abschluss-Record fehlt');
  if (instruments.length && ibag.length < 2) errors.push('pdta.ibag: Abschluss-Record fehlt');

  const pcmFrames = smpl ? Math.floor((smpl.end - smpl.start) / 2) : 0;
  const sampleViews = [];
  for (let i = 0; i < shdr.length; i++) {
    const sample = shdr[i];
    const path = `shdr[${i}]`;
    if (sample.start > sample.end) errors.push(`${path}: start > end`);
    if (sample.end > pcmFrames) {
      errors.push(`${path}: end ${sample.end} liegt hinter den PCM-Daten (${pcmFrames} Frames)`);
      continue;
    }
    if (sample.sampleRate < 400 || sample.sampleRate > 192000) {
      errors.push(`${path}: unplausible Samplerate ${sample.sampleRate} Hz`);
      continue;
    }
    if (sample.startLoop > sample.endLoop || sample.endLoop > sample.end) {
      warnings.push(`${path}: Loop-Grenzen unplausibel, Loop wird ignoriert`);
      sample.loopBroken = true;
    }
    sampleViews.push(sample);
  }

  const presetList = [];
  let zoneCount = 0;
  const presetRecords = presets.length - 1; // letzter Record ist „EOP"
  for (let p = 0; p < presetRecords; p++) {
    const header = presets[p];
    const nextHeader = presets[p + 1];
    const bagFrom = header.bagIndex;
    const bagTo = Math.min(nextHeader.bagIndex, pbag.length);
    const zones = [];
    for (let b = bagFrom; b < bagTo; b++) {
      const gens = genRange(pgen, pbag[b], pbag[b + 1]);
      const instIndex = firstGenValue(gens, GEN.instrument);
      if (instIndex == null || instIndex >= instruments.length) {
        warnings.push(`Preset „${header.name}": Zone ohne gültiges Instrument ignoriert`);
        continue;
      }
      const inst = instruments[instIndex];
      const iBagFrom = inst.bagIndex;
      const iBagTo = Math.min(instruments[instIndex + 1] ? instruments[instIndex + 1].bagIndex : ibag.length, ibag.length);
      for (let z = iBagFrom; z < iBagTo; z++) {
        const zoneGens = genRange(igen, ibag[z], ibag[z + 1]);
        const sampleIndex = firstGenValue(zoneGens, GEN.sampleID);
        if (sampleIndex == null || sampleIndex >= sampleViews.length) {
          warnings.push(`Preset „${header.name}": Zone ohne gültiges Sample ignoriert`);
          continue;
        }
        const sample = sampleViews[sampleIndex];
        const zone = { ...DEFAULT_ZONE, sampleIndex };
        applyGens(zone, gens, errors, `preset[${p}]`);
        zone.rootKey = sample.originalPitch <= 127 ? sample.originalPitch : zone.rootKey;
        applyGens(zone, zoneGens, errors, `inst[${instIndex}]`);
        const override = zoneGens.find((g) => g.oper === GEN.overridingRootKey);
        if (override) zone.rootKey = clampInt(override.amount, 0, 127);
        if (sample.loopBroken) zone.loop = false;
        zone.pitchCorrection = sample.pitchCorrection || 0;
        zone.sampleName = sample.name;
        zoneCount++;
        if (zoneCount > SF2_LIMITS.maxZones) {
          errors.push(`sf2: mehr als ${SF2_LIMITS.maxZones} Zonen`);
          break;
        }
        zones.push(zone);
      }
      if (zoneCount > SF2_LIMITS.maxZones) break;
    }
    if (!zones.length) {
      warnings.push(`Preset „${header.name}": keine spielbare Zone`);
      continue;
    }
    presetList.push({ name: header.name || `Preset ${p + 1}`, bank: header.bank, program: header.program, zones });
    if (presetList.length > SF2_LIMITS.maxPresets) break;
  }

  for (const preset of presetList) {
    for (const zone of preset.zones) {
      if (zone.keyLow > 127 || zone.keyHigh > 127 || zone.velLow > 127 || zone.velHigh > 127) {
        errors.push(`Preset „${preset.name}": Bereich außerhalb MIDI 0…127`);
        break;
      }
    }
  }

  if (!presetList.length && !errors.length) errors.push('sf2: keine spielbaren Presets gefunden');
  if (errors.length) return { ok: false, errors, warnings, soundfont: null };

  return {
    ok: true,
    errors,
    warnings,
    soundfont: {
      info,
      presets: presetList,
      samples: sampleViews,
      pcmFrames,
      pcm: smpl ? { start: smpl.start, end: smpl.end } : null,
      bytes,
      has24Bit: !!sm24,
    },
  };
}

/** Preset-Übersicht (ohne Zonen) für Auswahllisten. */
export function sf2Presets(soundfont) {
  if (!soundfont || !Array.isArray(soundfont.presets)) return [];
  return soundfont.presets.map((preset, index) => ({
    index,
    name: preset.name,
    bank: preset.bank,
    program: preset.program,
  }));
}

/** Preset über Programmnummer/Bank finden (Bank 0 = GM). */
export function findSf2Preset(soundfont, program = 0, bank = 0) {
  if (!soundfont || !Array.isArray(soundfont.presets)) return null;
  const index = soundfont.presets.findIndex((p) => p.program === program && p.bank === bank);
  if (index < 0) return null;
  return { index, ...soundfont.presets[index] };
}

/** Zonen, die eine Note (und Velocity 0…1) bedienen. */
export function zonesForNote(preset, note, velocity = 0.8) {
  if (!preset || !Array.isArray(preset.zones)) return [];
  const vel = clampInt(Math.round(Math.max(0, Math.min(1, velocity)) * 127), 0, 127);
  return preset.zones.filter((z) => note >= z.keyLow && note <= z.keyHigh && vel >= z.velLow && vel <= z.velHigh);
}

/**
 * PCM einer Zone als Float32 (mono). `rootKey`, `sampleRate` und Loop-Grenzen
 * sind relative Frames der Zone.
 */
export function readSf2Zone(soundfont, zone) {
  if (!soundfont || !zone) return null;
  const sample = soundfont.samples[zone.sampleIndex];
  if (!sample) return null;
  const { bytes } = soundfont;
  const startByte = soundfont.pcm.start + sample.start * 2;
  const endByte = soundfont.pcm.start + sample.end * 2;
  const frames = Math.max(0, Math.floor((endByte - startByte) / 2));
  const pcm = new Float32Array(frames);
  for (let i = 0; i < frames; i++) {
    const at = startByte + i * 2;
    const value = (bytes[at] | (bytes[at + 1] << 8)) << 16 >> 16; // int16
    pcm[i] = value / 32768;
  }
  return {
    pcm,
    sampleRate: sample.sampleRate,
    rootKey: zone.rootKey,
    loop: !!zone.loop,
    loopStart: Math.max(0, sample.startLoop - sample.start),
    loopEnd: Math.min(frames, sample.endLoop - sample.start),
    gain: zone.attenuation,
    pan: zone.pan,
    attack: zone.attack,
    release: zone.release,
  };
}
