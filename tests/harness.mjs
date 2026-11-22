/* Minimales Test-Harness ohne Dependencies. */

const tests = [];
let currentFile = '';

export function setFile(name) {
  currentFile = name;
}

export function test(name, fn) {
  tests.push({ file: currentFile, name, fn });
}

export function assert(cond, message) {
  if (!cond) throw new Error(message || 'Assertion fehlgeschlagen');
}

export function eq(actual, expected, message) {
  const a = JSON.stringify(actual);
  const b = JSON.stringify(expected);
  if (a !== b) throw new Error(`${message || 'Werte ungleich'} — ist: ${a}, soll: ${b}`);
}

export function near(actual, expected, tolerance, message) {
  if (typeof actual !== 'number' || !Number.isFinite(actual)) {
    throw new Error(`${message || 'Wert'} ist keine Zahl: ${actual}`);
  }
  if (Math.abs(actual - expected) > tolerance) {
    throw new Error(`${message || 'Wert'} — ist: ${actual}, soll: ${expected} ±${tolerance}`);
  }
}

export function throws(fn, message) {
  let threw = false;
  try {
    fn();
  } catch (e) {
    threw = true;
  }
  if (!threw) throw new Error(message || 'Fehler erwartet, keiner geworfen');
}

export async function run() {
  let passed = 0;
  const failures = [];
  let lastFile = '';

  for (const t of tests) {
    if (t.file !== lastFile) {
      lastFile = t.file;
      console.log(`\n${t.file}`);
    }
    try {
      await t.fn();
      passed += 1;
      console.log(`  ✓ ${t.name}`);
    } catch (err) {
      failures.push({ ...t, error: err });
      console.log(`  ✗ ${t.name}`);
      console.log(`      ${err && err.message ? err.message : err}`);
    }
  }

  console.log(`\n${passed}/${tests.length} Tests bestanden`);
  if (failures.length) {
    console.log('\nFehlgeschlagen:');
    for (const f of failures) console.log(`  - ${f.file} :: ${f.name}\n    ${f.error && f.error.stack ? f.error.stack.split('\n').slice(0, 3).join('\n    ') : f.error}`);
  }
  return { passed, failed: failures.length, failures };
}

export function count() {
  return tests.length;
}
