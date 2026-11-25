import { copyFile, mkdir, rename, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { E2E_WEB_PORT, startIsolatedE2E, type E2EFixture } from './isolation';

const fontURL = 'https://fonts.googleapis.com/css2?family=Alexandria:wght@100..900&display=swap';
const fontSubsets = {
  arabic: 'U+0600-06FF,U+0750-077F,U+0870-0891,U+0897-08E1,U+08E3-08FF,U+200C-200E,U+2010-2011,U+204F,U+2E41,U+FB50-FDFF,U+FE70-FE74,U+FE76-FEFC,U+102E0-102FB,U+10E60-10E7E,U+10EC2-10EC7,U+10EC9-10EEE,U+10EF0-10EFF,U+1EE00-1EEFF',
  latin: 'U+0000-00FF,U+0131,U+0152-0153,U+02BB-02BC,U+02C6,U+02DA,U+02DC,U+0304,U+0308,U+0329,U+2000-206F,U+20AC,U+2122,U+2191,U+2193,U+2212,U+2215,U+FEFF,U+FFFD',
};

async function prepareFonts({ directory, environment }: E2EFixture) {
  // Use Next's test response hook to keep the real layout and the actual font files offline.
  const css = await Promise.all(Object.entries(fontSubsets).map(async ([subset, range]) => {
    const name = `alexandria-${subset}.woff2`;
    const destination = path.join(directory, name);
    await copyFile(fileURLToPath(new URL(`./fixtures/fonts/${name}`, import.meta.url)), destination);
    const url = destination.replace(/^[a-z]:/i, '').replaceAll('\\', '/');
    return `/* ${subset} */\n@font-face {\n  font-family: 'Alexandria';\n  font-style: normal;\n  font-weight: 100 900;\n  font-display: swap;\n  src: url(${url}) format('woff2');\n  unicode-range: ${range};\n}`;
  }));
  const responses = path.join(directory, 'browser-premium-fonts.cjs');
  await writeFile(responses, `module.exports = ${JSON.stringify({ [fontURL]: css.join('\n') })};`);
  environment.NEXT_FONT_GOOGLE_MOCKED_RESPONSES = responses;
}

export default async function setup() {
  const fixture = await startIsolatedE2E({
    localBrain: true,
    prepareWeb: async fixture => {
      const route = path.join(fixture.webDirectory, 'app', 'browser-premium-matrix');
      await mkdir(route);
      await copyFile(fileURLToPath(new URL('./fixtures/browser-premium-page.tsx', import.meta.url)), path.join(route, 'page.tsx'));
      const configPath = path.join(fixture.webDirectory, 'next.config.ts');
      await rename(configPath, path.join(fixture.webDirectory, 'next.original.config.ts'));
      await writeFile(configPath, 'import config from "./next.original.config";\nexport default { ...config, devIndicators: false };\n');
      await prepareFonts(fixture);
    },
  });
  try {
    const response = await fetch(`http://127.0.0.1:${E2E_WEB_PORT}/browser-premium-matrix`, { signal: AbortSignal.timeout(170_000) });
    await response.body?.cancel();
    if (!response.ok) throw new Error(`The isolated browser premium matrix could not compile (${response.status})`);
    return fixture.stop;
  } catch (error) {
    await fixture.stop();
    throw error;
  }
}
