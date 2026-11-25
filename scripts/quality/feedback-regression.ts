import { readFile } from 'node:fs/promises';
import { replayFeedbackRegression } from './replay-feedback.js';

const file = process.argv[2];
if (!file || process.argv.length !== 3) {
  console.error('Usage: npx tsx scripts/quality/feedback-regression.ts <owner-regression-export.json>');
  process.exitCode = 2;
} else {
  try {
    const report = replayFeedbackRegression(await readFile(file, 'utf8'));
    console.log(JSON.stringify(report, null, 2));
    if (report.cases.some(row => row.selection.result === 'fail')) process.exitCode = 1;
  } catch {
    console.error('Could not read or verify the feedback regression export.');
    process.exitCode = 2;
  }
}
