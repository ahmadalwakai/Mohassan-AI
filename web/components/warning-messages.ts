import type { Language } from "./types";

const messages: Record<string, { ar: string; en: string }> = {
  source_instructions_ignored: {
    ar: "استُبعدت تعليمات غير مرتبطة بسؤالك وردت داخل بعض المصادر.",
    en: "Instructions unrelated to your question were excluded from the sources.",
  },
  duplicate_or_similar_sources_omitted: {
    ar: "استُبعدت المصادر المكررة أو شديدة التشابه.",
    en: "Duplicate or very similar sources were omitted.",
  },
  knowledge_version_unavailable: {
    ar: "تعذّر التأكد من آخر تحديث للمعرفة المحفوظة.",
    en: "The latest update to your saved knowledge could not be confirmed.",
  },
  invalid_conversion: {
    ar: "تعذّر تحويل هذه الوحدات. راجع الوحدات والقيمة.",
    en: "These units could not be converted. Check the units and value.",
  },
  invalid_calculation: {
    ar: "تعذّر حساب هذا التعبير. راجع الأرقام والعمليات المطلوبة.",
    en: "This expression could not be calculated. Check the numbers and operations.",
  },
  knowledge_unavailable: {
    ar: "تعذّر الوصول إلى معرفتك المحفوظة لهذه الإجابة.",
    en: "Your saved knowledge could not be accessed for this answer.",
  },
  knowledge_not_configured: {
    ar: "استخدام المعرفة المحفوظة غير مهيأ في اتصالك الحالي.",
    en: "Saved knowledge is not configured for your current connection.",
  },
  search_query_truncated_to_400_characters: {
    ar: "استخدم البحث الجزء الأول من سؤالك الطويل.",
    en: "The search used the beginning of your long question.",
  },
  search_query_simplified: {
    ar: "بُسّطت صياغة البحث للتركيز على موضوع سؤالك.",
    en: "The search wording was simplified to focus on your question’s subject.",
  },
  search_unavailable: {
    ar: "تعذّر البحث في الإنترنت الآن. لم يتأكد الحصول على معلومات حديثة.",
    en: "Web search was unavailable. Up-to-date information could not be confirmed.",
  },
  possible_source_conflict: {
    ar: "قد توجد أرقام غير متفقة في المقتطفات؛ لم يتأكد سبب الاختلاف.",
    en: "The extracts may contain differing figures; the reason for the difference is unresolved.",
  },
  summary_unavailable: {
    ar: "تعذّر إعداد ملخص. يمكنك مراجعة مقتطفات المصادر المعروضة.",
    en: "A summary could not be prepared. You can review the available source extracts.",
  },
  draft_rejected_or_insufficient_evidence: {
    ar: "تعذّر تقديم خلاصة مدعومة بما يكفي، لذا عُرضت مقتطفات المصادر.",
    en: "A sufficiently supported summary could not be produced, so source extracts are shown.",
  },
  search_total_cost_not_determined_from_usage: {
    ar: "التكلفة الإجمالية للبحث السحابي غير متاحة في بيانات الاستخدام.",
    en: "Usage details do not provide the total cost of the cloud search.",
  },
  unsupported_links_rejected: {
    ar: "لم تُعرض إجابة احتوت على روابط لم تُرجعها خدمة البحث.",
    en: "An answer containing links not returned by the search service was withheld.",
  },
  insufficient_web_citations: {
    ar: "لم تتوفر استشهادات ويب كافية لدعم الإجابة.",
    en: "There were not enough web citations to support the answer.",
  },
  memory_save_failed: {
    ar: "وصلت الإجابة، لكن لم يتأكد حفظ المحادثة.",
    en: "The answer arrived, but saving the conversation could not be confirmed.",
  },
  usage_record_failed: {
    ar: "لم يتأكد تحديث إحصاءات الاستخدام لهذه الإجابة.",
    en: "Updating usage statistics for this answer could not be confirmed.",
  },
};

export function warningMessage(code: string, language: Language): string {
  return messages[code]?.[language] ?? (language === "ar" ? "تفاصيل الأدلة محدودة. راجع المصادر قبل الاعتماد على الإجابة." : "Evidence details are limited. Review the sources before relying on the answer.");
}
