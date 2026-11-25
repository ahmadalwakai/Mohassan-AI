import { execFile, spawnSync } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { readFile, rename, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { promisify } from 'node:util';

const curl = promisify(execFile);

export interface SourcePin {
  url: string;
  sha256: string;
}

export const sourcePins = {
  'clinc150.json': {
    url: 'https://raw.githubusercontent.com/clinc/oos-eval/828f8093932c8fe6ca7936c3d2e52903b1c523de/data/data_full.json',
    sha256: '36923c3705a59e08fe9c3883d8bc2dd966ef93e22cb78ac41171782a698d56e0',
  },
  'massive-1.1.tar.gz': {
    url: 'https://amazon-massive-nlu-dataset.s3.amazonaws.com/amazon-massive-dataset-1.1.tar.gz',
    sha256: '4cba5faa11c71437928e17cb1b9b3d8b8e727e7ea363a3a9a8045e19c0491577',
  },
  'mintaka.json': {
    url: 'https://raw.githubusercontent.com/amazon-science/mintaka/b6146ffb41562803c45df3c028b4cdad8c09dd4d/data/mintaka_test.json',
    sha256: 'd2c94a7363d6374c67dacec3bd0ff26ab47c974d9fc5d85de91b555a89163221',
  },
  'tydiqa-ar.jsonl': {
    url: 'https://huggingface.co/datasets/khalidalt/tydiqa-goldp/resolve/7d69b53c9c8187ae7e21d8441362efa1a7e3013d/dev/arabic-dev.jsonl',
    sha256: '4f83dd49217fddca0cc9d3c5167146fbecf4dc075179e478ab19a2d1d4435e10',
  },
  'tydiqa-en.jsonl': {
    url: 'https://huggingface.co/datasets/khalidalt/tydiqa-goldp/resolve/7d69b53c9c8187ae7e21d8441362efa1a7e3013d/dev/english-dev.jsonl',
    sha256: 'c98e0cb9d0fda7351d9a5fe61f1d25feaa4f035c316feeba522a6ae97dfaf18a',
  },
  'canard.json': {
    url: 'https://raw.githubusercontent.com/aagohary/canard/da8639cee97a50b3c62dc4d7e800c93675731186/data/release/test.json',
    sha256: '7b01df7301734d7e76a14970965f0bf71b68f91d2ffd90eed16fef83bbd6a11f',
  },
  'gsm8k.jsonl': {
    url: 'https://raw.githubusercontent.com/openai/grade-school-math/3101c7d5072418e28b9008a6636bde82a006892c/grade_school_math/data/test.jsonl',
    sha256: '3730d312f6e3440559ace48831e51066acaca737f6eabec99bccb9e4b3c39d14',
  },
  'mbpp.json': {
    url: 'https://raw.githubusercontent.com/google-research/google-research/f46ca8374b4cddef97ca4208ad986049d74d296a/mbpp/sanitized-mbpp.json',
    sha256: 'ca95deaa9a01ef0a6f439f88bcf0dd3db3563d22f22aad6cae04ebb9a8d8c8e9',
  },
} as const satisfies Record<string, SourcePin>;

export const upstreamNoticePins = {
  'CANARD-RELEASE-NOTICE.txt': {
    url: 'https://raw.githubusercontent.com/aagohary/canard/da8639cee97a50b3c62dc4d7e800c93675731186/data/release/readme.txt',
    sha256: '938936c5c5ba5adf58296249dd9b44c311e3870a1ffeee263f38b1b675c9f51b',
  },
  'CC-BY-SA-3.0-LICENSE.txt': {
    url: 'https://creativecommons.org/licenses/by-sa/3.0/legalcode.txt',
    sha256: '3f941b3b89cf7b8370ceb83cc76d2120d471b58735d8ca60238a751a48d7f72f',
  },
  'CC-BY-SA-4.0-LICENSE.txt': {
    url: 'https://creativecommons.org/licenses/by-sa/4.0/legalcode.txt',
    sha256: '28a9529c7d0bb4dc51f4bf5c116a3d16ef247a052f7591466768ddf563fd1cf5',
  },
  'CLINC150-LICENSE.txt': {
    url: 'https://raw.githubusercontent.com/clinc/oos-eval/828f8093932c8fe6ca7936c3d2e52903b1c523de/LICENSE',
    sha256: 'e6bc9e9c474700b708f568bac9e5a8a9bcb2b1dad53442f5ba449fcb848b8e76',
  },
  'GSM8K-LICENSE.txt': {
    url: 'https://raw.githubusercontent.com/openai/grade-school-math/3101c7d5072418e28b9008a6636bde82a006892c/LICENSE',
    sha256: '86bbb73e855821d7c401912fd4bf82e34313e6e3b6fd6f909f2b6cc9e209a53b',
  },
  'MBPP-APACHE-LICENSE.txt': {
    url: 'https://raw.githubusercontent.com/google-research/google-research/f46ca8374b4cddef97ca4208ad986049d74d296a/LICENSE',
    sha256: 'cfc7749b96f63bd31c3c42b5c471bf756814053e847c10f3eb003417bc523d30',
  },
  'MBPP-DATASET-CARD.md': {
    url: 'https://huggingface.co/datasets/google-research-datasets/mbpp/raw/4bb6404fdc6cacfda99d4ac4205087b89d32030c/README.md',
    sha256: '6377d5c76ba46b9e650daa6d5eb592e671c9b15586e39f23f50ed9bf2ac54cf6',
  },
  'MINTAKA-LICENSE.md': {
    url: 'https://raw.githubusercontent.com/amazon-science/mintaka/b6146ffb41562803c45df3c028b4cdad8c09dd4d/LICENSE.md',
    sha256: '67e2204631e48323a0ca003d5788a36b18c0691133baa87e7d37978106f5a1f7',
  },
  'MINTAKA-RELEASE-NOTICE.md': {
    url: 'https://raw.githubusercontent.com/amazon-science/mintaka/b6146ffb41562803c45df3c028b4cdad8c09dd4d/README.md',
    sha256: '0b1695c01a6916780a51e47f6c8eebcd4aad033f7ea441814fdefd04de3a44d8',
  },
  'TYDIQA-APACHE-LICENSE.txt': {
    url: 'https://raw.githubusercontent.com/google-research-datasets/tydiqa/43cde6d598c1cf88c1a8b9ed32e89263ffb5e03b/LICENSE',
    sha256: 'cfc7749b96f63bd31c3c42b5c471bf756814053e847c10f3eb003417bc523d30',
  },
} as const satisfies Record<string, SourcePin>;

const pins = { ...sourcePins, ...upstreamNoticePins };

export function sha256(bytes: Buffer | string): string {
  return createHash('sha256').update(bytes).digest('hex');
}

export function verifiedBytes(name: string, bytes: Buffer, expected: string): Buffer {
  if (sha256(bytes) !== expected) throw new Error(`SHA-256 mismatch for ${name}.`);
  return bytes;
}

export async function downloadSource(cache: string, name: keyof typeof pins): Promise<Buffer> {
  const pin = pins[name];
  const path = join(cache, name);
  try {
    return verifiedBytes(name, await readFile(path), pin.sha256);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }
  const temporary = join(cache, `.download-${randomUUID()}`);
  try {
    try {
      await curl('curl', ['--disable', '--fail', '--silent', '--show-error', '--location', '--proto', '=https',
        '--proto-redir', '=https', '--retry', '2', '--max-time', '120', '--output', temporary, '--', pin.url]);
    } catch {
      throw new Error(`Could not download ${name}.`);
    }
    const bytes = verifiedBytes(name, await readFile(temporary), pin.sha256);
    await rename(temporary, path);
    return bytes;
  } finally {
    await rm(temporary, { force: true });
  }
}

export function sourceText(bytes: Buffer): string {
  return new TextDecoder('utf-8', { fatal: true }).decode(bytes);
}

function massiveEntry(archive: Buffer, entry: string): Buffer {
  const result = spawnSync('tar', ['-xzOf', '-', '--', entry], { input: archive, maxBuffer: 24 * 1024 * 1024 });
  if (result.status !== 0 || !result.stdout.length) throw new Error('Could not extract a pinned MASSIVE archive entry.');
  return result.stdout;
}

export function massiveLocale(archive: Buffer, locale: 'ar-SA' | 'en-US'): string {
  return sourceText(massiveEntry(archive, `1.1/data/${locale}.jsonl`));
}

export function massiveNotices(archive: Buffer): Record<string, Buffer> {
  const license = 'MASSIVE-LICENSE.txt';
  const notice = 'MASSIVE-NOTICE.md';
  return {
    [license]: verifiedBytes(license, massiveEntry(archive, '1.1/LICENSE'), 'c2e6ea015269147de02117ebdd91f30ef09831251f5345fa8365273b1db1d435'),
    [notice]: verifiedBytes(notice, massiveEntry(archive, '1.1/NOTICE.md'), 'b90534ccd20c6f0e1e5239567af0d150496339542b75a15bfbc3e1e737593ddb'),
  };
}
