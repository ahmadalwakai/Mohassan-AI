"""Text for synthetic lines: windows of real corpus text plus generated strings.

Every sample is a logical-order string with a base direction. Rendering turns it
into glyphs; `charset.to_visual` turns it into the label the model learns.
"""
from __future__ import annotations

import json
import random
import re
from pathlib import Path

from charset import ARABIC_DIGITS, classify, detect_base, normalize_text

ROOT = Path(__file__).resolve().parents[2]
DEFAULT_SOURCES = {
    "ar": [ROOT / "artifacts/corpora/lexicon-text/ar.txt", ROOT / "artifacts/corpora/arabic-foundation-v1/text/ar.train.jsonl"],
    "en": [ROOT / "artifacts/corpora/lexicon-text/en.txt", ROOT / "artifacts/corpora/arabic-foundation-v1/text/en.train.jsonl"],
}
MAX_CHARS = 64

UI_EN = ["OK", "Cancel", "Settings", "Sign in", "Log out", "Search", "Next", "Back", "Save", "Delete", "Submit", "Continue",
         "Home", "Menu", "Profile", "Notifications", "Download", "Upload", "Share", "Copy", "Paste", "Help", "Done", "Loading…",
         "Error", "Warning", "Success", "Price", "Total", "Subtotal", "Quantity", "Checkout", "Add to cart", "Free shipping",
         "Terms of Service", "Privacy Policy", "Read more", "Learn more", "Get started", "Try for free", "Contact us", "About us",
         "Email", "Password", "Username", "Remember me", "Forgot password?", "Create account", "Welcome back", "New chat",
         "Send", "Type a message…", "Yes", "No", "Close", "Open", "Edit", "View", "File", "Tools", "Window", "Refresh", "Apply",
         "Reply", "Forward", "Archive", "Inbox", "Sent", "Drafts", "Spam", "Trash", "Today", "Yesterday", "Tomorrow", "Online",
         "Offline", "Available", "Out of stock", "Order placed", "Track order", "Invoice", "Receipt", "Balance", "Payment"]
UI_AR = ["موافق", "إلغاء", "الإعدادات", "تسجيل الدخول", "تسجيل الخروج", "بحث", "التالي", "السابق", "حفظ", "حذف", "إرسال", "متابعة",
         "الرئيسية", "القائمة", "الملف الشخصي", "الإشعارات", "تحميل", "رفع", "مشاركة", "نسخ", "لصق", "مساعدة", "تم", "جار التحميل…",
         "خطأ", "تحذير", "نجاح", "السعر", "الإجمالي", "الكمية", "الدفع", "أضف إلى السلة", "شحن مجاني", "شروط الخدمة",
         "سياسة الخصوصية", "اقرأ المزيد", "اعرف أكثر", "ابدأ الآن", "جرب مجانا", "اتصل بنا", "من نحن", "البريد الإلكتروني",
         "كلمة المرور", "اسم المستخدم", "تذكرني", "هل نسيت كلمة المرور؟", "إنشاء حساب", "مرحبا بعودتك", "محادثة جديدة", "أرسل",
         "اكتب طلبك هنا…", "موحسن", "نعم", "لا", "إغلاق", "فتح", "تعديل", "عرض", "ملف", "أدوات", "نافذة", "تحديث", "تطبيق",
         "رد", "إعادة توجيه", "أرشفة", "الوارد", "المرسل", "المسودات", "غير مرغوب", "المحذوفات", "اليوم", "أمس", "غدا",
         "متصل", "غير متصل", "متوفر", "غير متوفر", "تم الطلب", "تتبع الطلب", "فاتورة", "إيصال", "الرصيد", "الدفع", "الكل"]
BRANDS = ["iPhone 15", "Samsung", "Google", "WhatsApp", "YouTube", "PDF", "Excel", "Windows 11", "Wi-Fi", "USB-C", "5G", "API",
          "HTML", "CSS", "Zoom", "Netflix", "Amazon", "PlayStation 5", "Instagram", "TikTok", "Gmail", "Chrome", "Android",
          "Bluetooth", "GPS", "LED", "4K", "SSD", "RAM", "CPU", "Mohassan", "Wasla", "OpenAI", "Claude", "Tesla", "BMW", "Toyota",
          "Nike", "Adidas", "Visa", "PayPal", "Uber", "Careem", "Noon", "Jarir", "STC", "Zain", "Mobily", "Aramco", "SABIC"]
MONTHS_EN = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"]
MONTHS_AR = ["يناير", "فبراير", "مارس", "أبريل", "مايو", "يونيو", "يوليو", "أغسطس", "سبتمبر", "أكتوبر", "نوفمبر", "ديسمبر"]
MONTHS_LEVANT = ["كانون الثاني", "شباط", "آذار", "نيسان", "أيار", "حزيران", "تموز", "آب", "أيلول", "تشرين الأول", "تشرين الثاني", "كانون الأول"]
DAYS_AR = ["السبت", "الأحد", "الاثنين", "الثلاثاء", "الأربعاء", "الخميس", "الجمعة"]
DAYS_EN = ["Saturday", "Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday"]
CURRENCY_EN = ["$", "€", "£", "SAR ", "AED ", "USD ", "EGP ", "KWD ", "QAR ", "¥"]
CURRENCY_AR = ["ريال", "ر.س", "درهم", "د.إ", "جنيه", "ج.م", "دينار", "د.ك", "ليرة", "ل.س", "ريال قطري", "دولار", "يورو"]
DOMAINS = ["example.com", "gmail.com", "mohassansy.com", "outlook.com", "yahoo.com", "company.sa", "shop.ae", "news.net", "site.org", "mail.co.uk"]
PATHS = ["", "/", "/login", "/help/faq", "/products/123", "/ar/about", "/search?q=test", "/docs/api/v2", "/user/profile", "/cart?items=3", "/post/2026/11/22"]
WORDS_EN = ["alpha", "beta", "support", "info", "sales", "ahmad", "sara", "team", "admin", "contact", "hello", "office", "news", "store", "dev", "api"]
WORD_RE = re.compile(r"\S+")


def _arabic_share(text: str) -> float:
    letters = [c for c in text if classify(c) in ("L", "R")]
    if not letters:
        return 0.0
    return sum(1 for c in letters if classify(c) == "R") / len(letters)


def load_lines(path: Path, limit: int, lang: str, seed: int = 1) -> list[str]:
    """Read up to `limit` usable lines from a .txt or .jsonl file, spread over the whole file."""
    if not path.exists():
        return []
    rng = random.Random(seed)
    size = path.stat().st_size
    keep_every = max(1, int(size / (limit * 160)))
    out: list[str] = []
    with path.open("r", encoding="utf-8", errors="ignore") as handle:
        for index, raw in enumerate(handle):
            if index % keep_every:
                continue
            if path.suffix == ".jsonl":
                try:
                    record = json.loads(raw)
                except ValueError:
                    continue
                text = next((record[key] for key in ("text", "content", "body") if isinstance(record.get(key), str)), "")
                pieces = [p.strip() for p in re.split(r"[\n\r]+|(?<=[.!?؟])\s+", text) if len(p.strip()) >= 12]
                if not pieces:
                    continue
                candidates = rng.sample(pieces, min(3, len(pieces)))
            else:
                candidates = [raw.strip()]
            for line in candidates:
                line = " ".join(line.split())
                if not 8 <= len(line) <= 400 or line.lower().startswith(("extracted-date", "description:", "http")):
                    continue
                share = _arabic_share(line)
                if lang == "ar" and share < 0.7:
                    continue
                if lang == "en" and (share > 0.0 or sum(1 for c in line if ord(c) > 0x24F) > len(line) * 0.02):
                    continue
                out.append(line)
                if len(out) >= limit:
                    return out
    return out


class TextSampler:
    def __init__(self, sources: dict[str, list[Path]] | None = None, per_source: int = 120_000, seed: int = 1) -> None:
        sources = sources or DEFAULT_SOURCES
        self.lines = {lang: [] for lang in ("ar", "en")}
        for lang in ("ar", "en"):
            for path in sources.get(lang, []):
                self.lines[lang].extend(load_lines(path, per_source, lang, seed))
        for lang in ("ar", "en"):
            if not self.lines[lang]:
                raise RuntimeError(f"no {lang} text lines found")

    # ---- real text windows
    def window(self, rng: random.Random, lang: str, max_words: int) -> str:
        for _ in range(20):
            words = WORD_RE.findall(rng.choice(self.lines[lang]))
            if not words:
                continue
            count = rng.randint(1, min(max_words, len(words)))
            start = rng.randint(0, len(words) - count)
            text = " ".join(words[start:start + count])
            if 1 <= len(text) <= MAX_CHARS:
                return text
        return rng.choice(UI_EN if lang == "en" else UI_AR)

    # ---- generated strings
    def number(self, rng: random.Random, arabic_digits: bool = False) -> str:
        kind = rng.random()
        if kind < 0.35:
            value = str(rng.randint(0, 10 ** rng.randint(1, 7)))
            if len(value) > 3 and rng.random() < 0.5:
                value = f"{int(value):,}"
        elif kind < 0.7:
            value = f"{rng.uniform(0, 10 ** rng.randint(1, 5)):.{rng.randint(1, 2)}f}"
        elif kind < 0.85:
            value = f"{rng.uniform(0, 100):.{rng.randint(0, 1)}f}%"
        else:
            value = f"-{rng.randint(1, 999)}"
        if arabic_digits:
            value = value.translate(str.maketrans("0123456789", ARABIC_DIGITS))
        return value

    def price(self, rng: random.Random, lang: str) -> str:
        amount = f"{rng.uniform(1, 20000):.{rng.choice([0, 2])}f}"
        if "." not in amount and rng.random() < 0.5 and len(amount) > 3:
            amount = f"{int(amount):,}"
        if lang == "en":
            symbol = rng.choice(CURRENCY_EN)
            return f"{symbol}{amount}" if not symbol.endswith(" ") else f"{symbol}{amount}"
        return f"{amount} {rng.choice(CURRENCY_AR)}"

    def date(self, rng: random.Random, lang: str) -> str:
        day, month, year = rng.randint(1, 28), rng.randint(1, 12), rng.randint(1990, 2030)
        hijri = rng.randint(1400, 1450)
        if lang == "en":
            return rng.choice([f"{day:02d}/{month:02d}/{year}", f"{year}-{month:02d}-{day:02d}", f"{MONTHS_EN[month - 1][:3]} {day}, {year}",
                               f"{MONTHS_EN[month - 1]} {day}, {year}", f"{rng.choice(DAYS_EN)}, {day} {MONTHS_EN[month - 1]}", f"{day}.{month}.{year}"])
        return rng.choice([f"{day}/{month}/{year}", f"{day} {MONTHS_AR[month - 1]} {year}", f"{rng.choice(DAYS_AR)} {day} {MONTHS_AR[month - 1]}",
                           f"{day} {MONTHS_LEVANT[month - 1]} {year}", f"{hijri}/{month}/{day} هـ".replace(" هـ", " هـ"),
                           f"{day} {MONTHS_AR[month - 1]}".translate(str.maketrans("0123456789", ARABIC_DIGITS))])

    def time(self, rng: random.Random, lang: str) -> str:
        hour, minute = rng.randint(0, 23), rng.randint(0, 59)
        if lang == "en":
            return rng.choice([f"{hour:02d}:{minute:02d}", f"{(hour % 12) or 12}:{minute:02d} {'AM' if hour < 12 else 'PM'}", f"{hour:02d}:{minute:02d}:{rng.randint(0, 59):02d}"])
        return rng.choice([f"{hour:02d}:{minute:02d}", f"الساعة {(hour % 12) or 12}:{minute:02d} {'صباحا' if hour < 12 else 'مساء'}", f"{(hour % 12) or 12}:{minute:02d} {'ص' if hour < 12 else 'م'}"])

    def phone(self, rng: random.Random) -> str:
        return rng.choice([f"+966 5{rng.randint(0, 9)} {rng.randint(100, 999)} {rng.randint(1000, 9999)}", f"05{rng.randint(10000000, 99999999)}",
                           f"+1 ({rng.randint(200, 989)}) 555-{rng.randint(1000, 9999)}", f"+971 {rng.randint(50, 58)} {rng.randint(100, 999)} {rng.randint(1000, 9999)}",
                           f"+44 20 {rng.randint(1000, 9999)} {rng.randint(1000, 9999)}", f"00963 9{rng.randint(10000000, 99999999)}"])

    def email(self, rng: random.Random) -> str:
        user = rng.choice(WORDS_EN) + rng.choice(["", ".", "_", str(rng.randint(1, 99))]) + rng.choice(WORDS_EN + [""])
        return f"{user}@{rng.choice(DOMAINS)}"

    def url(self, rng: random.Random) -> str:
        scheme = rng.choice(["https://", "http://", "", "www."])
        host = rng.choice(["www.", ""]) + rng.choice(DOMAINS) if not scheme.startswith("www") else rng.choice(DOMAINS)
        return f"{scheme}{host}{rng.choice(PATHS)}"

    def code(self, rng: random.Random) -> str:
        letters = "ABCDEFGHJKLMNPQRSTUVWXYZ"
        return rng.choice([f"{rng.choice(letters)}{rng.choice(letters)}{rng.choice(letters)}-{rng.randint(1000, 9999)}",
                           f"#{rng.randint(1000, 999999)}", f"{rng.choice(letters)}{rng.randint(0, 9)}{rng.choice(letters)}{rng.randint(0, 9)}-{rng.randint(10, 99)}{rng.choice(letters)}",
                           f"v{rng.randint(0, 12)}.{rng.randint(0, 20)}.{rng.randint(0, 9)}", f"{rng.randint(0, 255)}.{rng.randint(0, 255)}.{rng.randint(0, 255)}.{rng.randint(0, 255)}",
                           f"{rng.randint(1, 999)} KB", f"{rng.uniform(0.1, 99):.1f} MB", f"{rng.randint(1, 100)}%", f"{rng.randint(-20, 48)}°C"])

    def synthetic(self, rng: random.Random) -> str:
        lang = rng.choice(["en", "ar"])
        kind = rng.random()
        if kind < 0.15:
            return self.number(rng, arabic_digits=(lang == "ar" and rng.random() < 0.4))
        if kind < 0.3:
            return self.price(rng, lang)
        if kind < 0.42:
            return self.date(rng, lang)
        if kind < 0.5:
            return self.time(rng, lang)
        if kind < 0.57:
            return self.phone(rng)
        if kind < 0.64:
            return self.email(rng)
        if kind < 0.72:
            return self.url(rng)
        if kind < 0.8:
            return self.code(rng)
        labels = UI_EN if lang == "en" else UI_AR
        return " ".join(rng.choice(labels) for _ in range(rng.randint(1, 3)))

    def mixed(self, rng: random.Random) -> str:
        if rng.random() < 0.7:
            words = self.window(rng, "ar", 6).split()
            insert = rng.choice([rng.choice(BRANDS), self.number(rng), self.price(rng, "en"), self.code(rng), self.window(rng, "en", 2)])
            position = rng.randint(0, len(words))
            words.insert(position, insert)
            return " ".join(words)
        words = self.window(rng, "en", 7).split()
        words.insert(rng.randint(0, len(words)), self.window(rng, "ar", 2))
        return " ".join(words)

    def transform_case(self, rng: random.Random, text: str) -> str:
        roll = rng.random()
        if roll < 0.06:
            return text.upper()
        if roll < 0.18:
            return text.title()
        if roll < 0.22:
            return text.lower()
        return text

    def sample(self, rng: random.Random) -> tuple[str, str, str]:
        """Return (logical text, base direction, kind)."""
        for _ in range(50):
            roll = rng.random()
            if roll < 0.40:
                kind, text = "ar", self.window(rng, "ar", 8)
                if rng.random() < 0.15:
                    text = f"{text}{rng.choice(['.', '،', '؟', '!', ':', '…'])}"
            elif roll < 0.75:
                kind, text = "en", self.transform_case(rng, self.window(rng, "en", 10))
            elif roll < 0.85:
                kind, text = "mixed", self.mixed(rng)
            else:
                kind, text = "synthetic", self.synthetic(rng)
            label = normalize_text(text)
            if label and len(label) <= MAX_CHARS:
                base = detect_base(label)
                return label, base, kind
        return "OK", "L", "synthetic"


if __name__ == "__main__":
    import sys
    sampler = TextSampler(per_source=20_000)
    rng = random.Random(int(sys.argv[1]) if len(sys.argv) > 1 else 3)
    print({lang: len(lines) for lang, lines in sampler.lines.items()})
    for _ in range(30):
        text, base, kind = sampler.sample(rng)
        print(f"{kind:9s} {base} {text}")
