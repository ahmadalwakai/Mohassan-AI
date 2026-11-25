import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import Ajv from 'ajv';
import formats from 'ajv-formats';
import { githubFixture } from '../../tests/fixtures/monitors/github-rest.js';
import { simulationGithubFixtures } from './phase2-github-fixtures.js';

const expected = '1726204dfb4810d071301f3f89d8b862a83429a22179fd5e3b6fd9df09af992c';
const descriptionPath = process.argv[2];
if (!descriptionPath) throw new Error('Supply the locally retrieved OpenAPI 1.1.4 description for API version 2022-11-28.');
const bytes = readFileSync(descriptionPath);
if (createHash('sha256').update(bytes).digest('hex') !== expected) throw new Error('OpenAPI description checksum mismatch.');
const document = JSON.parse(bytes.toString('utf8'));
const documentId = 'urn:monitor-fixtures:github-openapi';
const ajv = new Ajv({ strict: false, allErrors: true });
formats(ajv);

// Translate the description's OpenAPI 3.0 nullable notation for JSON Schema.
// GitHub also puts nullable on composed types and omits null from some enums.
function translate(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(translate);
  if (!value || typeof value !== 'object') return value;
  const { nullable, ...fields } = value as Record<string, unknown>;
  const translated = Object.fromEntries(Object.entries(fields).map(([key, field]) => [key, translate(field)]));
  return nullable === true ? { anyOf: [{ type: 'null' }, translated] } : translated;
}
document.components.schemas = translate(document.components.schemas);

ajv.addSchema({ ...document, $id: documentId });
const operations = {
  '/pulls/{pull_number}': ['pull', 'merged', 'closed', 'pullMoved'],
  '/branches/{branch}': ['branch', 'branchMoved'],
  '/commits/{ref}/status': ['status', 'ciPending', 'ciStatusOnPull'],
  '/commits/{ref}/check-runs': ['checks', 'ciFailed', 'ciQueued', 'ciChecksOnPull'],
  '/releases': ['releases', 'noReleases'],
  '/releases/latest': ['release'],
  '/tags': ['tags'],
} as const satisfies Record<string, readonly (keyof typeof githubFixture)[]>;

let unitCount = 0;
let simulationCount = 0;
for (const [operation, fixtures] of Object.entries(operations)) {
  const endpoint = `/repos/{owner}/{repo}${operation}`;
  const encoded = endpoint.replace(/\//gu, '~1');
  const validate = ajv.compile({ $ref: `${documentId}#/paths/${encoded}/get/responses/200/content/application~1json/schema` });
  for (const key of fixtures) {
    if (!validate(githubFixture[key])) throw new Error(`${key} ${endpoint}: ${ajv.errorsText(validate.errors)}`);
    unitCount++;
  }
  for (const [index, fixture] of (simulationGithubFixtures[operation] ?? []).entries()) {
    if (!validate(fixture)) throw new Error(`Simulation fixture ${index + 1} ${endpoint}: ${ajv.errorsText(validate.errors)}`);
    simulationCount++;
  }
}
console.log(`Validated ${unitCount} unit fixtures and ${simulationCount} simulation fixtures across ${Object.keys(operations).length} GitHub REST operations.`);
