import { writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { renderClientApiContracts } from './client-api/report.js';

const root = process.cwd();
writeFileSync(resolve(root, 'docs/CLIENT-API-CONTRACTS.md'), renderClientApiContracts(root));
