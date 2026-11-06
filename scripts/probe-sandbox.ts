import 'dotenv/config';
import { WindowsAppContainerSandbox } from '../packages/sandbox/src/index.js';

const sandbox = new WindowsAppContainerSandbox();
const availability = await sandbox.available();
const readiness = await sandbox.executableReadiness();

console.log(`Baseline isolation: ${availability.available ? 'verified' : 'NOT verified'}`);
console.log(`Executable skills: ${readiness.enabled ? 'gates open' : 'closed'}`);
for (const gate of readiness.gates) console.log(`${gate.id} ${gate.status === 'verified' ? 'verified' : 'BLOCKED '} ${gate.name}${gate.status === 'verified' ? '' : ` — ${gate.reason}`}`);

const details: [string, string | undefined][] = [['G2 quota', sandbox.quotaProbeError], ['G5 LPAC', sandbox.lpacProbeError], ['G5 public resource', sandbox.publicResourceProbeError], ['G8 side channels', sandbox.sideChannelProbeError]];
for (const [name, detail] of details) if (detail) console.log(`${name}: ${detail}`);
const quota = sandbox.quotaProbeEvidence;
if (quota) console.log(`Quota fixture: ${quota.stdout.trim()} on a volume of ${quota.nativeControls?.quotaVolumeBytes} bytes`);
process.exit(readiness.enabled ? 0 : 1);
