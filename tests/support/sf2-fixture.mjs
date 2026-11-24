/* Baut kleinste gültige SF2-Dateien für die Parsertests.
 *
 * Warum ein eigener Writer im Test und keine echte Soundfont-Datei im Repo:
 * das Repo soll asset-frei bleiben (Lizenzfragen), und der Parser muss gegen
 * das Format geprüft werden, nicht gegen eine einzelne Datei. Der Writer
 * erzeugt exakt die Chunks, die die SF2-Spezifikation vorschreibt
 * (INFO / sdta.smpl / pdta.phdr|pbag|pmod|pgen|inst|ibag|imod|igen|shdr).
 *
 * Aufbau: je Preset ein Instrument, je Sample eine Zone (ibag/igen), damit
 * Key-Bereiche und Loop-Flags wirklich getrennt geprüft werden können.
 */

class Writer {
  constructor() {
    this.bytes = [];
  }

  u8(v) {
    this.bytes.push(v & 0xff);
    return this;
  }

  u16(v) {
    return this.u8(v).u8(v >> 8);
  }

  u32(v) {
    return this.u16(v & 0xffff).u16((v >>> 16) & 0xffff);
  }

  ascii(text, length) {
    for (let i = 0; i < length; i++) this.u8(text.charCodeAt(i) || 0);
    return this;
  }

  raw(array) {
    for (const b of array) this.u8(b);
    return this;
  }

  get data() {
    return Uint8Array.from(this.bytes);
  }

  get size() {
    return this.bytes.length;
  }
}

function chunk(id, data) {
  const w = new Writer();
  w.ascii(id, 4);
  w.u32(data.length);
  w.raw(data);
  if (data.length % 2) w.u8(0); // Chunks werden auf 2 Byte gepolstert
  return w.data;
}

function list(type, chunks) {
  const w = new Writer();
  w.ascii(type, 4);
  for (const c of chunks) w.raw(c);
  return chunk('LIST', w.data);
}

function textChunk(id, value) {
  const w = new Writer();
  for (const ch of String(value)) w.u8(ch.charCodeAt(0));
  w.u8(0);
  return chunk(id, w.data);
}

function infoChunk(name, { author = 'Test', copyright = 'CC0' } = {}) {
  return list('INFO', [textChunk('INAM', name), textChunk('IENG', author), textChunk('ICOP', copyright)]);
}

/** 16-Bit-PCM-Sägezahn, damit Wertebereiche prüfbar sind. */
function saw(frames, amplitude = 12000) {
  const w = new Writer();
  for (let i = 0; i < frames; i++) {
    const value = Math.round(amplitude * ((i % 100) / 50 - 1));
    w.u16(value & 0xffff);
  }
  return w.data;
}

/**
 * @param {object} options
 * @param {Array} options.samples  { name, frames, sampleRate, pitch, loopStart, loopEnd, loop, keyLow, keyHigh }
 * @param {Array} options.presets  { name, program, bank }
 * @param {boolean} options.sm24   zusätzlichen 24-Bit-Chunk anhängen
 */
export function buildSf2({ samples = [], presets = [], sm24 = false, infoName = 'Testfont' } = {}) {
  const sampleDefs = samples.length
    ? samples
    : [{ name: 'Samp', frames: 512, sampleRate: 44100, pitch: 60, loopStart: 32, loopEnd: 480, loop: true }];
  const presetDefs = presets.length ? presets : [{ name: 'Piano', program: 0, bank: 0 }];

  /* ---- PCM + Sample-Köpfe ---- */
  const pcmParts = [];
  let frameAt = 0;
  const sampleHeaders = sampleDefs.map((sample) => {
    const frames = Math.max(1, sample.frames || 512);
    const start = frameAt;
    frameAt += frames;
    pcmParts.push(saw(frames, sample.amplitude || 12000));
    return {
      name: sample.name || 'Samp',
      start,
      end: start + frames,
      startLoop: start + (sample.loopStart != null ? sample.loopStart : 0),
      endLoop: start + (sample.loopEnd != null ? sample.loopEnd : frames),
      sampleRate: sample.sampleRate || 44100,
      pitch: sample.pitch != null ? sample.pitch : 60,
      loop: !!sample.loop,
      keyLow: sample.keyLow != null ? sample.keyLow : 0,
      keyHigh: sample.keyHigh != null ? sample.keyHigh : 127,
    };
  });
  const pcmBytes = Uint8Array.from(pcmParts.flatMap((part) => [...part]));

  /* ---- pdta.phdr / pbag / pgen ---- */
  const phdr = new Writer();
  const pbag = new Writer();
  const pgen = new Writer();
  presetDefs.forEach((preset, i) => {
    phdr
      .ascii(preset.name || `Preset ${i}`, 20)
      .u16(preset.program != null ? preset.program : i)
      .u16(preset.bank != null ? preset.bank : 0)
      .u16(i)
      .u32(0)
      .u32(0)
      .u32(0);
    pbag.u16(i).u16(0);
    pgen.u16(41).u16(i); // 41 = instrument, je Preset ein Instrument
  });
  phdr.ascii('EOP', 20).u16(0).u16(0).u16(presetDefs.length).u32(0).u32(0).u32(0);
  pbag.u16(presetDefs.length).u16(0);
  pgen.u16(0).u16(0);
  const pmod = new Writer().u16(0).u16(0).u16(0).u16(0).u16(0);

  /* ---- pdta.inst / ibag / igen (eine Zone je Sample) ---- */
  const inst = new Writer();
  const ibag = new Writer();
  const igen = new Writer();
  let genIndex = 0;
  let bagIndex = 0;
  presetDefs.forEach((preset, p) => {
    const instrumentName = `Inst ${p}`;
    inst.ascii(instrumentName, 20).u16(bagIndex);
    sampleHeaders.forEach((sample, z) => {
      ibag.u16(genIndex).u16(0);
      bagIndex++;
      igen.u16(53).u16(z); // sampleID
      genIndex++;
      igen.u16(43).u16((sample.keyLow & 0xff) | ((sample.keyHigh & 0xff) << 8)); // keyRange
      genIndex++;
      if (sample.loop) {
        igen.u16(54).u16(1); // sampleModes: 1 = Loop
        genIndex++;
      }
    });
  });
  igen.u16(0).u16(0); // Abschluss-Generator
  inst.ascii('EOI', 20).u16(bagIndex); // Abschluss-Instrument zeigt auf Abschluss-Bag
  ibag.u16(genIndex).u16(0); // Abschluss-Bag zeigt hinter den letzten Generator
  const imod = new Writer().u16(0).u16(0).u16(0).u16(0).u16(0);

  /* ---- pdta.shdr ---- */
  const shdr = new Writer();
  sampleHeaders.forEach((sample) => {
    shdr
      .ascii(sample.name, 20)
      .u32(sample.start)
      .u32(sample.end)
      .u32(sample.startLoop)
      .u32(sample.endLoop)
      .u32(sample.sampleRate)
      .u8(sample.pitch)
      .u8(0) // pitchCorrection
      .u16(0) // sampleLink
      .u16(1); // sampleType: mono
  });
  shdr.ascii('EOS', 20).u32(0).u32(0).u32(0).u32(0).u32(0).u8(0).u8(0).u16(0).u16(0);

  const sdtaChunks = [chunk('smpl', pcmBytes)];
  if (sm24) sdtaChunks.push(chunk('sm24', new Uint8Array(Math.ceil(pcmBytes.length / 2))));

  const pdta = list('pdta', [
    chunk('phdr', phdr.data),
    chunk('pbag', pbag.data),
    chunk('pmod', pmod.data),
    chunk('pgen', pgen.data),
    chunk('inst', inst.data),
    chunk('ibag', ibag.data),
    chunk('imod', imod.data),
    chunk('igen', igen.data),
    chunk('shdr', shdr.data),
  ]);

  const riffBody = Uint8Array.from([
    ...new TextEncoder().encode('sfbk'),
    ...infoChunk(infoName),
    ...list('sdta', sdtaChunks),
    ...pdta,
  ]);
  const riff = new Writer();
  riff.ascii('RIFF', 4);
  riff.u32(riffBody.length);
  riff.raw(riffBody);
  return riff.data;
}
