import { writeFileSync } from 'node:fs';

const sampleRate = 24_000;
const duration = 0.45;
const sampleCount = Math.round(sampleRate * duration);
const bytes = Buffer.alloc(44 + sampleCount * 2);
const notes = [{ frequency: 659.25, offset: 0 }, { frequency: 880, offset: 0.12 }];

bytes.write('RIFF', 0);
bytes.writeUInt32LE(bytes.length - 8, 4);
bytes.write('WAVEfmt ', 8);
bytes.writeUInt32LE(16, 16);
bytes.writeUInt16LE(1, 20); // PCM
bytes.writeUInt16LE(1, 22); // Mono
bytes.writeUInt32LE(sampleRate, 24);
bytes.writeUInt32LE(sampleRate * 2, 28);
bytes.writeUInt16LE(2, 32);
bytes.writeUInt16LE(16, 34);
bytes.write('data', 36);
bytes.writeUInt32LE(sampleCount * 2, 40);

for (let i = 0; i < sampleCount; i++) {
  const time = i / sampleRate;
  let sample = 0;
  for (const { frequency, offset } of notes) {
    const age = time - offset;
    if (age < 0) continue;
    const phase = 2 * Math.PI * frequency * age;
    const envelope = Math.min(age / 0.018, 1) * Math.exp(-age / 0.11);
    sample += (Math.sin(phase) + 0.2 * Math.sin(phase * 2)) * envelope;
  }
  const fadeOut = Math.min((duration - time) / 0.04, 1);
  bytes.writeInt16LE(Math.round(sample * fadeOut * 5_600), 44 + i * 2);
}

writeFileSync(new URL('../apps/web/public/mohassan-done.wav', import.meta.url), bytes);
