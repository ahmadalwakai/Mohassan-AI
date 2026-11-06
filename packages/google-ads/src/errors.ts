/** Safe by construction: messages shown to the owner never carry a token or Google's raw text. */
export class GoogleAdsError extends Error {
  constructor(
    public readonly code: string,
    message: string,
    public readonly statusCode = 409,
    public readonly options: { retryAfterSeconds?: number; requestId?: string; googleCodes?: string[] } = {},
  ) { super(message); this.name = 'GoogleAdsError'; }
}

export const notConfigured = () => new GoogleAdsError('GOOGLE_ADS_NOT_CONFIGURED', 'لم تُجهَّز بيانات Google Cloud على الخادم بعد.', 409);
export const notConnected = () => new GoogleAdsError('GOOGLE_ADS_DISCONNECTED', 'لم يُربط حساب Google Ads بعد.', 409);
export const unauthorized = () => new GoogleAdsError('GOOGLE_ADS_UNAUTHORIZED', 'انتهى تفويض Google أو أُلغي. أعد ربط الحساب.', 401);
export const stateConflict = (message: string) => new GoogleAdsError('GOOGLE_ADS_STATE', message, 409);
