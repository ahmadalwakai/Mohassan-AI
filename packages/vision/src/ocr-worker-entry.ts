import { loadOcrModelFromBytes, type OcrModel } from './ocr-model.js';
import { recognizeLine, type LineCrop, type LineRecognition } from './recognize.js';

/** Loaded inside a worker thread; nothing here touches the parent's state. */
export function loadForWorker(manifestBytes: Uint8Array, weightsBytes: Uint8Array): OcrModel {
  return loadOcrModelFromBytes(manifestBytes, weightsBytes);
}

export function recognizeMany(model: OcrModel, crops: readonly LineCrop[]): LineRecognition[] {
  return crops.map(crop => recognizeLine(model, crop));
}
