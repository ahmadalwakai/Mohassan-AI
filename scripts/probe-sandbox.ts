import { WindowsAppContainerSandbox } from '../packages/sandbox/src/index.js';
const sandbox = new WindowsAppContainerSandbox();
console.log(JSON.stringify({availability:await sandbox.available(),evidence:sandbox.probeEvidence}));
