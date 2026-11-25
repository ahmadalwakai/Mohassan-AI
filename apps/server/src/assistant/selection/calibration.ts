export interface SelectionWeights {
  type: number;
  inferredEntity: number;
  overlap: number;
  position: number;
}

export interface SelectionCalibration extends SelectionWeights {
  threshold: number;
}

export const originalCalibration: Readonly<SelectionCalibration> = {
  threshold: 61, type: 12, inferredEntity: 22, overlap: 26, position: 7,
};

/** Selected on the frozen development partition by the corpus calibration test. */
export const combinedCalibration: Readonly<SelectionCalibration> = { ...originalCalibration, type: 16 };
