"""Mine conservative service phrases from the already-local lexicon text corpus.

This is a high-precision candidate miner, not a linguistic parser. Explicit offering
contexts and activity heads constrain the phrases; every result preserves an exact
source span. It reads no labelled examples, evaluation files, or network resources.
The grammar decides train/validation membership after loading the phrases.
"""
from __future__ import annotations

import argparse
from collections import Counter
import hashlib
import json
from pathlib import Path
import re
from typing import Iterator


EN_CONTEXT = re.compile(
    r"\b(?:we\s+(?:(?:also|can|proudly)\s+)?(?:offer|provide|speciali[sz]e\s+in)|"
    r"our\s+(?:services|specialities|specialties)\s+include)\s+", re.I)
AR_CONTEXT = re.compile(
    r"(?<![\u0600-\u06ff])(?:[ون]?(?:نقدم|نوفر)|خدماتنا\s+تشمل|متخصصون\s+في|متخصصة\s+في)\s+")
EN_BOUNDARY = re.compile(
    r"[,;:.!?()\[\]{}|/\n]|\s+(?:and|or|for|to|in|at|with|through|across|from|"
    r"that|which|who|including|designed|tailored|using|throughout|as|by|on|when|"
    r"ensuring|without|available|such|so|you|your|our)\b", re.I)
AR_BOUNDARY = re.compile(
    r"[,،;؛:.!?؟()\[\]{}|/\n…]|\s+(?:في|من|إلى|الى|عن|على|مع|عبر|لكل|لكافة|"
    r"لجميع|للأفراد|للشركات|للعملاء|للزبائن|لكم|لك|التي|الذي|حيث|حتى|كما|"
    r"بأعلى|باعلى|بأفضل|بافضل|بأقل|باقل|بأسعار|باسعار|بدقة|بجودة|باحترافية|"
    r"بكفاءة|بكوادر|بواسطة|متكاملة|المتكاملة|متميزة|المتميزة|المتنوعة|متنوعة|"
    r"عالية|العالية|شاملة|الشاملة|متخصصة|المتخصصة|مختلفة|المختلفة|مجاناً|مجانا|مجانية|"
    r"تضمن|تساعد|تلبي|تغطي|تعمل|تقدم|تشمل|يساعد|وتقع|لحماية|حسب|بمختلف|داخل|خارج|شمال|جنوب|شرق|غرب|وسط|"
    r"مجموعة|جميع|كافة|كل|مثل|هذه|هذا|أو|او|"
    r"وال[\u0600-\u06ff]+|ون[\u0600-\u06ff]+)\b")
EN_PREFIX = re.compile(
    r"^(?:(?:a|an|the|our|your|expert|professional|quality|comprehensive|complete|"
    r"excellent|exceptional|reliable|affordable|bespoke|customized|customised|"
    r"specialist|specialized|specialised|innovative|various|full|premium|"
    r"high-quality|top-quality|top-notch|best|outstanding|advanced)\s+)+", re.I)
EN_HEADS = set((
    "repair repairs restoration cleaning installation maintenance inspection inspections "
    "servicing services solutions support training coaching tuition lessons classes courses "
    "workshops tours walks surveying surveys consulting consultancy counselling counseling "
    "therapy therapies treatment treatments design construction renovation renovations "
    "remodeling remodelling decoration decorating fitting landscaping gardening plumbing "
    "roofing carpentry joinery tiling painting plastering glazing welding printing framing "
    "photography videography catering delivery deliveries removal removals transport "
    "transportation storage rentals rental hire sales manufacturing fabrication machining "
    "engineering development bookkeeping accounting accountancy auditing translation "
    "interpretation proofreading editing tutoring security recruitment insurance marketing "
    "management recycling disposal clearance valuation valuations appraisal appraisals "
    "surgery dentistry care grooming boarding sitting walking cleaning detailing "
    "insulation waterproofing paving flooring windows doors furniture equipment supplies "
    "products accessories clothing shoes jewellery jewelry bags lamps candles cosmetics "
    "meals cakes bread flowers plants gifts toys tools furniture upholstery embroidery "
    "scaffolding removals surveying acupuncture osteopathy physiotherapy yoga pilates "
    "massage reflexology meditation rehabilitation diagnostics testing consultations "
    "calibration certification packaging signage branding animation graphics illustrations "
    "instruments machinery automation hosting repair lessons fabrication conservation"
).split())
EN_FORBIDDEN = set((
    "i we they he she it you us them me him her its my his their this these those all any some many more most other others "
    "only just very be is are was were being been have has had do does did can could "
    "would should may might will shall must not no never if because while although "
    "about after before between over under than then there here such both each every "
    "of to for with into get got give make find want need let help ensure meet offer offers provide "
    "provides includes include working looking based located dedicated committed "
    "free unlimited superior good great first second third wide range variety number "
    "several few additional also same different option options information experience following numerous "
    "clients customers providing delivering creating helping performing comprehensive offering making crafting another benefits like dealers one "
    "opportunity opportunities rights reserved copyright privacy policy contact email "
    "click visit read today now tomorrow yesterday annual daily weekly monthly "
    "adult adults porn pornography sex sexual escort escorts casino casinos gambling "
    "drugs drug weapons weapon loans loan funding finance financial investment investments"
).split())
AR_HEADS = set((
    "خدمات تنظيف صيانة إصلاح اصلاح تركيب فك نقل شحن توصيل تصنيع إنتاج انتاج "
    "بيع توريد تصليح ترميم عزل كشف مكافحة معالجة تنسيق تصميم تطوير برمجة "
    "ترجمة تدقيق مراجعة محاسبة تدريس تعليم تدريب دروس دورات استشارات "
    "استشارة تأجير تاجير تأمين تامين رعاية عناية حجز تصوير طباعة حفر دهان "
    "طلاء بناء تشييد تجهيز تفصيل خياطة حلاقة تجميل زراعة تربية علاج فحص "
    "تحليل تقييم تخزين تعبئة تغليف استيراد تصدير توزيع تنظيفات حفلات "
    "منتجات معدات أدوات ادوات أجهزة اجهزة مستلزمات أثاث اثاث ملابس أحذية "
    "احذية حقائب شموع هدايا عطور مجوهرات أزهار ازهار ورد نباتات أغذية "
    "اغذية مطابخ أبواب ابواب نوافذ سجاد مفروشات حراسات الحراسات"
).split())
AR_FORBIDDEN = set((
    "ما لا لم لن إن ان أن كان كانت يكون تكون نحن هم هي هو أنت انت أنا انا "
    "هذا هذه ذلك تلك التي الذي الذين عندما خلال منذ قبل بعد تحت فوق بين "
    "حول إلى الى عن على عند هنا هناك جدا جداً فقط أيضا ايضاً أيضا جميع "
    "كل بعض أي اي أكثر اكثر أفضل افضل أهم اهم جديد جديدة للحصول الحصول "
    "المزيد المزيدة بطريقة شكل مجال المجال نوع أنواع انواع النوع النوعية "
    "الجودة الأسعار الاسعار الشركة المؤسسة الموقع الصفحة الرئيسية اتصل "
    "بنا معنا حقوق محفوظة سياسة الخصوصية البريد الإلكتروني تسجيل الدخول "
    "المستخدم المستخدمين العملاء العميل الزبائن الزبون الناس الإنسان الانسان "
    "الإسلام الاسلام قرآن القران قرآن الكريم المجانية مجانا المجاني "
    "سكس جنس جنسي جنسية إباحية اباحية قمار مراهنات مخدرات أسلحة اسلحة"
).split())
AR_PROMOTION = {"المتكامل", "متكامل", "المتطورة", "متطورة", "الحديثة", "حديثة", "الاحترافية", "احترافية"}
AR_SERVICE_QUALIFIERS = set("قانونية قانونيه طبية هندسية محاسبية لوجستية سياحية سياحيه أمنية امنية تعليمية تدريبية تجميلية بيطرية الحراسة الحراسات".split())
EN_GENERIC = set("versatile discounted exterior top-grade tailored flexible high-performance ongoing wraparound new rush thorough emergency fast expert professional quality specialized customised customized specialist premium technical excellent exceptional reliable affordable comprehensive complete various advanced effective efficient generic holistic annual regular seasonal custom full high low speed quick rapid durable wide personal personalised personalized individual trusted superior innovative modern innovative thorough quality first-class high-quality top-quality top-of-the-line cost-effective top-notch personalized customised free affordable different unique best finest great outstanding unparalleled uncompromising specific unlimited unrivalled extensive easy convenient competitive sustainable valuable relevant convenient available friendly helpful proven prompt efficient continuous leading exclusive impressive diverse large great personalized separate fantastic comprehensive".split())
AR_UNSPECIFIC = set("أصلية مضمونة مختصة أمنة وفريدة احترافي الفريدة مستمرة كاملة الأخبار أخر الطلب".split())
AR_PLACE_WORDS = set("الرياض الكويت جدة الدوحة ابها الفيحاء القصور الدمام دبي مكة أبوظبي الشارقة القاهرة".split())
EN_SERVICE_SUBJECTS = set("tree dental beauty urology tax pest control law heating cooling electrical gas laundry eyewear funeral logistical logistics conciliation concierging logistics floral seo hvac av fm oem odm xrf hiv cloud seo storage mobile computer piano guitar financial legal pet dog cat chimney greenhouse solar boiler fence gate gutter roof floor waste water air fire energy security courier shipping towing building refurbishment moving asbestos laboratory medical clinical technical customer tenancy accommodation disability autism software website accessibility cybersecurity internet business commercial residential estate".split())


def _sha(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as stream:
        for chunk in iter(lambda: stream.read(1 << 20), b""):
            digest.update(chunk)
    return digest.hexdigest()


def extract_line(line: str, language: str) -> Iterator[tuple[str, int, int]]:
    """Yield exact contiguous phrase spans, never a truncated overlength candidate."""
    if language not in {"ar", "en"}:
        raise ValueError("Only Arabic and English are supported")
    context = EN_CONTEXT if language == "en" else AR_CONTEXT
    boundary = EN_BOUNDARY if language == "en" else AR_BOUNDARY
    for match in context.finditer(line):
        start = match.end()
        remainder = line[start:]
        boundary_match = boundary.search(remainder)
        end = start + (boundary_match.start() if boundary_match else len(remainder))
        raw = line[start:end]
        if language == "en":
            descriptive = re.match(r"(?:high quality|highly specialized|thoroughly exhaustive|thoroughly|highly)\s+", line[start:end], re.I)
            if descriptive:
                start += descriptive.end()
            prefix = EN_PREFIX.match(line[start:end])
            if prefix:
                start += prefix.end()
        else:
            prefix = re.match(r"(?:خدمة\s+)?(?:الـ)?", raw)
            start += prefix.end()
        while start < end and line[start].isspace():
            start += 1
        while end > start and line[end - 1].isspace():
            end -= 1
        phrase = line[start:end]
        words = phrase.split()
        if not 2 <= len(words) <= 6 or len(phrase) > 100:
            continue
        if language == "en":
            if not re.fullmatch(r"[A-Za-z]+(?:-[A-Za-z]+)*(?: [A-Za-z]+(?:-[A-Za-z]+)*)*", phrase):
                continue
            normalized = [word.lower() for word in words]
            if normalized[-2:] in (["delivery", "windows"], ["collection", "windows"], ["time", "windows"]):
                continue  # Availability periods are not window products or service names.
            if normalized[-1] not in EN_HEADS or set(normalized) & EN_FORBIDDEN:
                continue
            if normalized[0] in {"services", "solutions", "support", "products"}:
                continue
            if normalized[-1] in {"services", "solutions", "support", "products"} and not (set(normalized[:-1]) & (EN_HEADS | EN_SERVICE_SUBJECTS)):
                continue
            if normalized[-1] in {"services", "solutions", "support", "products", "care", "delivery", "consultations", "treatment", "training", "classes", "equipment"} and all(word in EN_GENERIC for word in normalized[:-1]):
                continue
            # Proper-name lists and shouting boilerplate are not service names.
            if any(word[0].isupper() for word in words[1:]) or phrase.isupper():
                continue
            if words[0][0].isupper() and not words[0].isupper():
                continue
            if any(word.endswith("ly") for word in normalized):
                continue
        else:
            if not re.fullmatch(r"[ء-ي]+(?: [ء-ي]+)*", phrase):
                continue
            if words[0] not in AR_HEADS or set(words) & (AR_FORBIDDEN | AR_PROMOTION):
                continue
            if set(words) & (AR_UNSPECIFIC | AR_PLACE_WORDS):
                continue
            if words[0] in {"منتجات", "أدوات", "ادوات"} and len(words) < 3:
                continue
            if words[0] == "خدمات" and words[1].removeprefix("ال") not in AR_HEADS and words[1] not in AR_SERVICE_QUALIFIERS:
                continue
            if set(words) & {"بن", "ابن", "محمد", "أحمد", "احمد"}:
                continue
            if any(word.startswith(("لل", "بال", "وال")) for word in words[1:]):
                continue
            if all(word.removeprefix("و") in AR_HEADS for word in words):
                continue
            if words[0] == "خدمات" and len(words) == 2 and words[1] in {"نقل", "شحن", "عامة", "خاصة", "أخرى", "اخرى"}:
                continue
        yield phrase, start, end


def extract_file(path: Path, language: str) -> tuple[list[dict], dict]:
    candidates: dict[str, dict] = {}
    count = 0
    with path.open(encoding="utf-8") as stream:
        for line_number, line in enumerate(stream, 1):
            count = line_number
            line = line.rstrip("\r\n")
            for phrase, start, end in extract_line(line, language):
                key = phrase.casefold()
                if key in candidates:
                    candidates[key]["occurrences"] += 1
                    continue
                candidates[key] = {
                    "text": phrase, "occurrences": 1,
                    "provenance": {"source": path.name, "line": line_number, "start": start, "end": end,
                                   "lineSha256": hashlib.sha256(line.encode("utf-8")).hexdigest()},
                }
    # Stable order prevents high-frequency crawl spam from dominating sampling.
    phrases = sorted(candidates.values(), key=lambda row: hashlib.sha256(row["text"].casefold().encode()).hexdigest())
    return phrases, {"path": str(path.resolve()), "sha256": _sha(path), "lines": count,
                     "phrases": len(phrases), "wordCounts": dict(sorted(Counter(len(p["text"].split()) for p in phrases).items()))}


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--source", type=Path, default=Path("artifacts/corpora/lexicon-text"))
    parser.add_argument("--out", type=Path, required=True)
    args = parser.parse_args()
    if args.out.exists():
        parser.error(f"Refusing to overwrite output directory: {args.out}")
    languages, sources = {}, {}
    for language in ("ar", "en"):
        languages[language], sources[language] = extract_file(args.source / f"{language}.txt", language)
        print(json.dumps({"language": language, **sources[language]}, ensure_ascii=False), flush=True)
    args.out.mkdir(parents=True)
    payload = {"schemaVersion": 1, "languages": languages}
    services = args.out / "services.json"
    services.write_text(json.dumps(payload, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    manifest = {"schemaVersion": 1, "sources": sources, "servicesSha256": _sha(services),
                "extractorSha256": _sha(Path(__file__)), "network": False, "externalModel": False,
                "labelledExamplesRead": False, "evaluationDataRead": False,
                "method": "Conservative offering-context extraction with activity heads and exact source spans.",
                "limitations": "Heuristic candidates, not human-verified labels; source language and phrase completeness can be imperfect.",
                "splitPolicy": "No split assigned here; grammar must split phrases deterministically."}
    (args.out / "manifest.json").write_text(json.dumps(manifest, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
