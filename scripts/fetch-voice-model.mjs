// Downloads the offline speech model used by the "Clip that" voice command
// (Vosk small English model, Apache-2.0) into resources/models, verifying its SHA-256.
// The installer bundles this file; at runtime nothing is downloaded.
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';

const FILE = 'resources/models/vosk-model-small-en-us-0.15.tar.gz';
const URL = 'https://ccoreilly.github.io/vosk-browser/models/vosk-model-small-en-us-0.15.tar.gz';
const SHA256 = 'f0b24bb92a48ca575b6a96500d6b543f0f079c573dfe85bbe16001fc0404e1d8';
const hash = (b) => createHash('sha256').update(b).digest('hex');

if (existsSync(FILE) && hash(readFileSync(FILE)) === SHA256) {
  console.log(`Voice model present and verified: ${FILE}`);
  process.exit(0);
}
mkdirSync('resources/models', { recursive: true });
console.log(`Downloading ${URL} …`);
const res = await fetch(URL);
if (!res.ok) throw new Error(`Download failed: HTTP ${res.status}`);
const buf = Buffer.from(await res.arrayBuffer());
if (hash(buf) !== SHA256) throw new Error('Checksum mismatch: refusing to install the voice model');
writeFileSync(FILE, buf);
console.log(`Voice model installed: ${FILE} (${(buf.length / 1048576).toFixed(1)} MB)`);
