import { setPdfMetadata } from '@mohassan/pdf';
import { pdfFixture } from '../../../packages/learning/src/pdf-fixture.js';

/** Keep the known bilingual glyph contents and write the served document through Mohassan's pdf-lib worker. */
export function writeMonitorPdfFixture(pages: readonly string[]): Promise<Buffer> {
  return setPdfMetadata(pdfFixture(pages), { title: 'Public monitor fixture', author: 'Mohassan tests' });
}
