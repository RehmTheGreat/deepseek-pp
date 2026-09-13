// Injects the Web Store "key" into a built Chrome MV3 manifest so a
// --load-unpacked install reuses the store extension ID (and therefore its
// on-disk storage dirs). The key is NEVER embedded in this file: it is read
// at runtime from a source manifest passed on the command line.
//
// Usage:
//   node scripts/inject-extension-key.mjs <sourceManifestWithKey> <builtManifest>
//
// ID derivation (Chromium): sha256(base64-decode(key)) -> first 16 bytes ->
// hex -> map 0-9a-f onto a-p.
import { readFileSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';

const EXPECTED_ID = 'kdmpkkahkhdmdhfkdihkopikgcocbpbf';

function idFromKey(base64Key) {
  const spki = Buffer.from(base64Key, 'base64');
  const digest = createHash('sha256').update(spki).digest();
  const hex = digest.subarray(0, 16).toString('hex');
  // Chromium maps hex nibble n (0-15) onto the letter chr(97 + n): 0->a ... f->p.
  return [...hex].map((c) => String.fromCharCode(97 + parseInt(c, 16))).join('');
}

const [sourceManifestPath, builtManifestPath] = process.argv.slice(2);
if (!sourceManifestPath || !builtManifestPath) {
  console.error('Usage: node scripts/inject-extension-key.mjs <sourceManifestWithKey> <builtManifest>');
  process.exit(2);
}

const source = JSON.parse(readFileSync(sourceManifestPath, 'utf8'));
if (typeof source.key !== 'string' || source.key.length === 0) {
  console.error('ABORT: source manifest has no "key" field');
  process.exit(1);
}

const derivedFromSource = idFromKey(source.key);
console.log(`ID derived from source key: ${derivedFromSource}`);
if (derivedFromSource !== EXPECTED_ID) {
  console.error(`ABORT: derived ID does not equal expected ${EXPECTED_ID}`);
  process.exit(1);
}

const built = JSON.parse(readFileSync(builtManifestPath, 'utf8'));
if (typeof built.key === 'string' && built.key.length > 0) {
  console.log('Built manifest already has a key; leaving as-is.');
} else {
  // Preserve the original byte layout of the built manifest (single-line JSON).
  const raw = readFileSync(builtManifestPath, 'utf8');
  const injected = raw.replace(
    /^(\{\s*)/m,
    `$1"key": ${JSON.stringify(source.key)},\n   `,
  );
  writeFileSync(builtManifestPath, injected, 'utf8');
  console.log(`Injected key into ${builtManifestPath}`);
}

// Re-verify from the file on disk, not from memory.
const reread = JSON.parse(readFileSync(builtManifestPath, 'utf8'));
const derivedFromBuilt = idFromKey(reread.key);
console.log(`ID derived from built manifest: ${derivedFromBuilt}`);
if (derivedFromBuilt !== EXPECTED_ID) {
  console.error(`ABORT: built-manifest ID does not equal expected ${EXPECTED_ID}`);
  process.exit(1);
}
console.log(`OK: both derivations equal ${EXPECTED_ID}`);
