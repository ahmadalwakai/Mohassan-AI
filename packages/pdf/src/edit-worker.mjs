import { parentPort, workerData } from 'node:worker_threads';
import { PDFDocument, StandardFonts, degrees, rgb } from 'pdf-lib';

// Structural edits only, on untrusted PDF bytes, inside a worker the host can terminate.
// No network, no evaluation, no file system: the bytes come in and the result goes back.
globalThis.fetch = async () => { throw new Error('PDF_NETWORK_DISABLED'); };
globalThis.eval = () => { throw new Error('PDF_EVAL_DISABLED'); };

const { op, inputs, params, limits } = workerData;
const fail = code => { throw { code }; };

async function load(bytes) {
  let document;
  try {
    document = await PDFDocument.load(bytes, { ignoreEncryption: false, updateMetadata: false, throwOnInvalidObject: false });
  } catch (error) {
    if (error?.constructor?.name === 'EncryptedPDFError' || /encrypt/iu.test(String(error?.message ?? ''))) fail('PDF_ENCRYPTED');
    fail('PDF_INVALID');
  }
  if (document.isEncrypted) fail('PDF_ENCRYPTED');
  // A leniently parsed file with no usable page tree fails here, not deep inside an operation.
  let pages = 0;
  try { pages = document.getPageCount(); for (let index = 0; index < Math.min(pages, limits.pages); index++) document.getPage(index).getSize(); }
  catch { fail('PDF_INVALID'); }
  if (pages > limits.pages) fail('PDF_PAGE_LIMIT');
  if (pages === 0) fail('PDF_INVALID');
  return document;
}

/** 1-based page numbers checked against the document; the whole document when absent. */
function indicesOf(document, pages) {
  const total = document.getPageCount();
  if (!pages) return document.getPageIndices();
  const indices = [...new Set(pages)].map(page => page - 1);
  if (!indices.length || indices.some(index => !Number.isInteger(index) || index < 0 || index >= total)) fail('PDF_PAGE_RANGE');
  return indices.sort((a, b) => a - b);
}

async function finish(document) {
  document.setProducer('Mohassan PDF');
  document.setModificationDate(new Date());
  const bytes = await document.save({ useObjectStreams: true, updateFieldAppearances: false });
  if (bytes.byteLength > limits.outputBytes) fail('PDF_OUTPUT_LIMIT');
  if (document.getPageCount() > limits.pages) fail('PDF_PAGE_LIMIT');
  return bytes;
}

const iso = value => value instanceof Date && Number.isFinite(value.getTime()) ? value.toISOString() : null;

async function run() {
  if (op === 'info') {
    const document = await load(inputs[0]);
    const first = document.getPage(0).getSize();
    return { info: {
      pages: document.getPageCount(), title: document.getTitle() ?? null, author: document.getAuthor() ?? null, subject: document.getSubject() ?? null,
      keywords: document.getKeywords() ?? null, creator: document.getCreator() ?? null, producer: document.getProducer() ?? null,
      created: iso(document.getCreationDate()), modified: iso(document.getModificationDate()),
      pageSize: { width: Math.round(first.width), height: Math.round(first.height) },
    } };
  }
  if (op === 'merge') {
    const output = await PDFDocument.create();
    let total = 0;
    for (const bytes of inputs) {
      const document = await load(bytes);
      total += document.getPageCount();
      if (total > limits.pages) fail('PDF_PAGE_LIMIT');
      for (const page of await output.copyPages(document, document.getPageIndices())) output.addPage(page);
    }
    return { bytes: await finish(output) };
  }
  const document = await load(inputs[0]);
  if (op === 'extract') {
    const chosen = new Set(indicesOf(document, params.pages));
    const kept = params.exclude ? document.getPageIndices().filter(index => !chosen.has(index)) : [...chosen];
    if (!kept.length) fail('PDF_PAGE_RANGE');
    const output = await PDFDocument.create();
    for (const page of await output.copyPages(document, kept)) output.addPage(page);
    return { bytes: await finish(output) };
  }
  if (op === 'rotate') {
    if (![90, 180, 270].includes(params.angle)) fail('PDF_PARAMS');
    for (const index of indicesOf(document, params.pages)) {
      const page = document.getPage(index);
      page.setRotation(degrees((page.getRotation().angle + params.angle) % 360));
    }
    return { bytes: await finish(document) };
  }
  if (op === 'reorder') {
    const order = indicesOf(document, params.order);
    const sortedUnique = [...new Set(params.order)].length === document.getPageCount();
    if (!sortedUnique || params.order.length !== document.getPageCount()) fail('PDF_PAGE_RANGE');
    const output = await PDFDocument.create();
    const copied = await output.copyPages(document, params.order.map(page => page - 1));
    for (const page of copied) output.addPage(page);
    void order;
    return { bytes: await finish(output) };
  }
  if (op === 'metadata') {
    if (typeof params.title === 'string') document.setTitle(params.title);
    if (typeof params.author === 'string') document.setAuthor(params.author);
    if (typeof params.subject === 'string') document.setSubject(params.subject);
    if (Array.isArray(params.keywords)) document.setKeywords(params.keywords.filter(value => typeof value === 'string'));
    return { bytes: await finish(document) };
  }
  if (op === 'overlay') {
    const overlayDocument = await load(inputs[1]);
    const [stamp] = await document.embedPdf(overlayDocument, [0]);
    const opacity = Math.min(1, Math.max(0.05, Number(params.opacity ?? 1)));
    for (const index of indicesOf(document, params.pages)) {
      const page = document.getPage(index);
      const { width, height } = page.getSize();
      page.drawPage(stamp, { x: 0, y: 0, width, height, opacity });
    }
    return { bytes: await finish(document) };
  }
  if (op === 'number') {
    const font = await document.embedFont(StandardFonts.Helvetica);
    const size = Math.min(16, Math.max(7, Number(params.size ?? 10)));
    const margin = Math.min(60, Math.max(8, Number(params.margin ?? 22)));
    const total = document.getPageCount();
    const start = Number.isInteger(params.start) && params.start > 0 ? params.start : 1;
    for (const index of indicesOf(document, params.pages)) {
      const page = document.getPage(index);
      const text = params.total === false ? String(index + start) : `${index + start} / ${total + start - 1}`;
      const { width } = page.getSize();
      page.drawText(text, { x: (width - font.widthOfTextAtSize(text, size)) / 2, y: margin, size, font, color: rgb(0.4, 0.4, 0.4) });
    }
    return { bytes: await finish(document) };
  }
  fail('PDF_PARAMS');
}

try {
  const result = await run();
  if (result.bytes) parentPort.postMessage({ bytes: result.bytes }, [result.bytes.buffer]);
  else parentPort.postMessage(result);
} catch (error) {
  parentPort.postMessage({ error: typeof error?.code === 'string' ? error.code : 'PDF_EDIT_FAILED' });
}
