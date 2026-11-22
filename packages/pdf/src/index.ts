export { PdfError } from './errors.ts';
export { PDF_LIMITS } from './limits.ts';
export {
  DOCUMENT_THEMES, PAGE_SIZES, DocumentBlockSchema, DocumentSpecSchema, FONT_STACK, WATERMARK_PRINT,
  blockStrings, detectLang, documentTextLength, escapeHtml, parseDocumentText, renderDocumentHtml, watermarkHtml,
  type DocumentBlock, type DocumentLang, type DocumentSpec, type DocumentSpecInput, type DocumentTheme, type PageSize, type PrintOptions, type RenderedDocument,
} from './html.ts';
export { DEFAULT_FONTS_DIR, createPdfRenderer, loadFontFaces, type PdfRenderer, type PdfRendererOptions, type RenderOptions } from './render.ts';
export {
  deletePages, extractPages, mergePdfs, numberPages, parsePageSelection, pdfInfo, reorderPages, rotatePages, setPdfMetadata, stampPdf,
  type EditOptions, type PdfInfo,
} from './edit.ts';
