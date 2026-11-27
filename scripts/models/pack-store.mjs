import { tsImport } from 'tsx/esm/api';

try {
  const { main } = await tsImport('./pack-store.ts', import.meta.url);
  process.exitCode = await main(process.argv.slice(2));
} catch (error) {
  console.error(error.message);
  process.exitCode = 1;
}
