import { CodingDeviceErrorCodeSchema, type CodingDeviceErrorCode } from './protocol.js';

const messages: Record<CodingDeviceErrorCode, Record<'ar' | 'en', string>> = {
  CODING_DEVICE_NOT_PAIRED: {
    ar: 'لم يُربط جهاز للبرمجة بعد. اربط جهاز Windows من قسم «مشاريع البرمجة».',
    en: 'No coding device is paired. Pair your Windows PC in Coding Projects.',
  },
  CODING_DEVICE_OFFLINE: {
    ar: 'جهاز البرمجة المرتبط غير متصل. افتح تطبيق سطح المكتب على الجهاز وتحقق من اتصاله.',
    en: 'The paired coding device is offline. Open the desktop app on that PC and check its connection.',
  },
  CODING_DEVICE_TIMEOUT: {
    ar: 'انتهت مهلة المهمة قبل إرسالها إلى الجهاز.',
    en: 'The job expired before it could be sent to the device.',
  },
  CODING_DEVICE_RESULT_UNKNOWN: {
    ar: 'لم تصل نتيجة المهمة من الجهاز. لن تُعاد المهمة تلقائيًا.',
    en: 'The device did not return a result. The job will not be re-run automatically.',
  },
  CODING_DEVICE_PATH_DENIED: {
    ar: 'المشروع خارج المجلدات المسموحة على جهازك. أضف مجلده من «مجلدات المشاريع المسموحة…» في قائمة موحسن على الجهاز، ثم أعد الطلب.',
    en: 'The project is outside the folders allowed on your PC. Add its folder from Allowed project folders… in the Mohassan tray menu on the PC, then try again.',
  },
  CODING_DEVICE_VERSION: {
    ar: 'إصدار ربط جهاز البرمجة غير متوافق مع الخادم. حدّث نسخة محرك البرمجة على الجهاز.',
    en: 'The coding device uses an incompatible protocol version. Update the coding engine on the PC.',
  },
  CODING_DEVICE_SANDBOX_UNAVAILABLE: {
    ar: 'جهاز البرمجة متصل، لكن بيئة العزل على الجهاز غير جاهزة.',
    en: 'The coding device is online, but its sandbox is unavailable.',
  },
  CODING_DEVICE_RESULT_TOO_LARGE: {
    ar: 'تجاوزت نتيجة الجهاز الحجم المسموح. تعذّر اعتمادها.',
    en: 'The result from the device exceeded the size limit and could not be accepted.',
  },
  CODING_DEVICE_BAD_RESULT: {
    ar: 'وصلت نتيجة من الجهاز، لكن الخادم لم يستطع التحقق من بنيتها.',
    en: 'The device returned a result whose format could not be verified.',
  },
  CODING_DEVICE_CANCELLED: {
    ar: 'أُلغيت مهمة البرمجة.',
    en: 'The coding job was cancelled.',
  },
  CODING_DEVICE_DISABLED: {
    ar: 'ربط جهاز البرمجة معطّل على الخادم.',
    en: 'The coding device link is disabled on the server.',
  },
};

export function codingDeviceFailureText(value: unknown, lang: 'ar' | 'en'): string | undefined {
  const code = CodingDeviceErrorCodeSchema.safeParse(value);
  return code.success ? messages[code.data][lang] : undefined;
}

export function codingDeviceTaskFailureText(error: string | null, lang: 'ar' | 'en'): string | undefined {
  return codingDeviceFailureText(error?.split(':', 1)[0], lang);
}
