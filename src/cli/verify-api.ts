/**
 * READ-ONLY API check from the command line (same check as the dashboard button).
 * Usage: npm run verify-api
 * Writes data/verify/report.md plus raw responses (tokens removed).
 */
import fs from 'node:fs';
import path from 'node:path';
import { buildApp } from '../app.ts';
import { runVerification } from '../verify.ts';

const app = buildApp({ quiet: true });
console.log('\nCOLDEST API check (read-only: nothing will be changed)\n');
let section = '';
const result = await runVerification(app, (l) => {
  if (l.section !== section) console.log(`\n== ${(section = l.section)} ==`);
  console.log(`${l.ok === null ? '  •' : l.ok ? '✔' : '✘'} ${l.text}`);
});
const outDir = path.resolve('data/verify');
fs.mkdirSync(outDir, { recursive: true });
fs.writeFileSync(path.join(outDir, 'report.md'), result.markdown);
for (const [name, data] of Object.entries(result.raw)) fs.writeFileSync(path.join(outDir, `${name}.json`), JSON.stringify(data, null, 2));
console.log(`\n${result.verdict}\n\nFull report: ${path.join(outDir, 'report.md')}\nPlease send Claude that report.md (it contains no passwords or tokens).\n`);
app.repo.close();
