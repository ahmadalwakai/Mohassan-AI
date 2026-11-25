import { importClinc, importMassive } from './intent.js';
import { importGsm8k, importMbpp } from './math-code.js';
import { importCanard, importMintaka, importTyDiQA } from './qa.js';
import { downloadSource, massiveLocale, massiveNotices, sourcePins, sourceText, upstreamNoticePins } from './sources.js';

type Artifacts = Map<keyof typeof sourcePins, Buffer>;

export async function downloadCapabilitySources(cache: string): Promise<Artifacts> {
  const artifacts: Artifacts = new Map();
  // Keep the download order fixed and avoid retaining duplicate archive copies.
  for (const name of Object.keys(sourcePins) as (keyof typeof sourcePins)[]) {
    artifacts.set(name, await downloadSource(cache, name));
  }
  return artifacts;
}

export function mapCapabilitySources(artifacts: Artifacts) {
  const raw = (name: keyof typeof sourcePins) => sourceText(artifacts.get(name)!);
  const massive = artifacts.get('massive-1.1.tar.gz')!;
  return [
    importClinc(raw('clinc150.json')),
    importMassive(massiveLocale(massive, 'en-US'), massiveLocale(massive, 'ar-SA')),
    importMintaka(raw('mintaka.json')),
    importTyDiQA(raw('tydiqa-ar.jsonl'), raw('tydiqa-en.jsonl')),
    importCanard(raw('canard.json')),
    importGsm8k(raw('gsm8k.jsonl')),
    importMbpp(raw('mbpp.json')),
  ];
}

export async function collectCapabilityNotices(cache: string, artifacts: Artifacts) {
  const notices = massiveNotices(artifacts.get('massive-1.1.tar.gz')!);
  for (const name of Object.keys(upstreamNoticePins) as (keyof typeof upstreamNoticePins)[]) {
    notices[name] = await downloadSource(cache, name);
  }
  return notices;
}
