import { pdfProblemMessage } from '@mohassan/contracts/reply-messages';
import { PDF_LIMITS, type PdfError } from '@mohassan/pdf';

export function pdfProblemReply(request: string, error: PdfError): string {
  return pdfProblemMessage(request, error, PDF_LIMITS);
}
