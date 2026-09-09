import { execFileSync } from 'node:child_process';
import { writeFileSync } from 'node:fs';

// Fail packaging rather than ship a release that identifies itself as +dev.
const sha = execFileSync('git', ['rev-parse', '--short', 'HEAD'], { encoding: 'utf8' }).trim();
const time = new Date().toISOString().replace(/\D/g, '').slice(0, 14);
writeFileSync('dist/build-info.json', JSON.stringify({ stamp: `${sha}.${time}` }) + '\n');
