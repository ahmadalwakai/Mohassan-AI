/** Small deterministic PDFs for parser security tests; no authoring dependency. */
export function pdfFixture(pages: readonly string[], options: { imageOnly?: boolean; encrypted?: boolean; script?: string; compressed?: Uint8Array } = {}): Buffer {
  const characters = [...new Set(pages.join('').split(''))];
  const hex = (value: string) => [...value].map(char => char.charCodeAt(0).toString(16).padStart(4, '0')).join('');
  const cmap = `/CIDInit /ProcSet findresource begin\n12 dict begin\nbegincmap\n/CIDSystemInfo << /Registry (Fixture) /Ordering (Identity) /Supplement 0 >> def\n/CMapName /Fixture def\n/CMapType 2 def\n1 begincodespacerange\n<0000> <FFFF>\nendcodespacerange\n${characters.length} beginbfchar\n${characters.map(char => `<${hex(char)}> <${hex(char)}>`).join('\n')}\nendbfchar\nendcmap\nCMapName currentdict /CMap defineresource pop\nend\nend`;
  const stream = (content: string | Uint8Array, attributes = '') => { const bytes = Buffer.from(content); return Buffer.concat([Buffer.from(`<< /Length ${bytes.length} ${attributes} >>\nstream\n`), bytes, Buffer.from('\nendstream')]); };
  const objects: (string | Buffer)[] = [
    '<< /Type /Catalog /Pages 2 0 R >>', '',
    '<< /Type /Font /Subtype /Type0 /BaseFont /Fixture /Encoding /Identity-H /DescendantFonts [4 0 R] /ToUnicode 5 0 R >>',
    '<< /Type /Font /Subtype /CIDFontType2 /BaseFont /Fixture /CIDSystemInfo << /Registry (Adobe) /Ordering (Identity) /Supplement 0 >> /DW 1000 /CIDToGIDMap /Identity >>',
    stream(cmap),
    stream(Uint8Array.from([220, 70, 20]), '/Type /XObject /Subtype /Image /Width 1 /Height 1 /ColorSpace /DeviceRGB /BitsPerComponent 8'),
  ];
  const pageIds: number[] = [];
  for (const text of pages) {
    const page = objects.length + 1, contents = page + 1; pageIds.push(page);
    objects.push(`<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 3 0 R >> /XObject << /Im1 6 0 R >> >> /Contents ${contents} 0 R >>`);
    // A PDF stores displayed glyph order; the extractor applies its bidi mapping.
    const visualText = text.replace(/[\u0600-\u06ff]+/gu, word => [...word].reverse().join(''));
    objects.push(options.compressed ? stream(options.compressed, '/Filter /FlateDecode') : stream(options.imageOnly ? 'q 100 0 0 100 10 10 cm /Im1 Do Q' : `BT /F1 12 Tf 50 750 Td <${hex(visualText)}> Tj ET`));
  }
  objects[1] = `<< /Type /Pages /Count ${pageIds.length} /Kids [${pageIds.map(id => `${id} 0 R`).join(' ')}] >>`;
  if (options.script) {
    const scriptId = objects.length + 1;
    objects.push(`<< /S /JavaScript /JS <${Buffer.from(options.script).toString('hex')}> >>`);
    objects[0] = `<< /Type /Catalog /Pages 2 0 R /OpenAction ${scriptId} 0 R >>`;
  }
  let encryption = '';
  if (options.encrypted) {
    objects.push(`<< /Filter /Standard /V 1 /R 2 /Length 40 /P -4 /O <${'00'.repeat(32)}> /U <${'00'.repeat(32)}> >>`);
    encryption = `/Encrypt ${objects.length} 0 R /ID [<${'10'.repeat(16)}> <${'10'.repeat(16)}>]`;
  }
  const sections = [Buffer.from('%PDF-1.7\n%fixture\n')], offsets = [0]; let size = sections[0].length;
  for (let index = 0; index < objects.length; index++) {
    offsets.push(size);
    const section = Buffer.concat([Buffer.from(`${index + 1} 0 obj\n`), Buffer.from(objects[index]), Buffer.from('\nendobj\n')]);
    sections.push(section); size += section.length;
  }
  sections.push(Buffer.from(`xref\n0 ${objects.length + 1}\n0000000000 65535 f \n${offsets.slice(1).map(offset => `${String(offset).padStart(10, '0')} 00000 n \n`).join('')}trailer\n<< /Size ${objects.length + 1} /Root 1 0 R ${encryption} >>\nstartxref\n${size}\n%%EOF\n`));
  return Buffer.concat(sections);
}
