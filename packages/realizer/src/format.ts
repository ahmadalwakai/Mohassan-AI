import type { CalendarDate, Presentation } from "./frame.js";

const LRI = "\u2066";
const FSI = "\u2068";
const PDI = "\u2069";

const gregorianMonths = {
  en: ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"],
  ar: ["يناير", "فبراير", "مارس", "أبريل", "مايو", "يونيو", "يوليو", "أغسطس", "سبتمبر", "أكتوبر", "نوفمبر", "ديسمبر"],
};

const hijriMonths = {
  en: ["Muharram", "Safar", "Rabi al-Awwal", "Rabi al-Thani", "Jumada al-Awwal", "Jumada al-Thani",
    "Rajab", "Shaban", "Ramadan", "Shawwal", "Dhu al-Qadah", "Dhu al-Hijjah"],
  ar: ["المحرم", "صفر", "ربيع الأول", "ربيع الآخر", "جمادى الأولى", "جمادى الآخرة",
    "رجب", "شعبان", "رمضان", "شوال", "ذو القعدة", "ذو الحجة"],
};

export function formatText(text: string, language: Presentation["language"]): string {
  const clean = text.replace(/\p{Bidi_Control}/gu, "").replace(/[\p{Cc}\s]+/gu, " ").trim();
  if (language === "ar" && /[\p{Script=Latin}\p{N}]/u.test(clean)) {
    return FSI + clean + PDI;
  }
  return clean;
}

function formatDigits(text: string, options: Presentation): string {
  const digits = options.digits === "arabic-indic"
    ? text.replace(/[0-9]/g, digit => "٠١٢٣٤٥٦٧٨٩"[Number(digit)]).replace(/,/g, "٬").replace(/\./g, "٫")
    : text;
  return options.language === "ar" ? LRI + digits + PDI : digits;
}

export function formatNumber(amount: number, options: Presentation): string {
  if (!Number.isFinite(amount)) throw new RangeError("Expected a finite number");

  // Expand the shortest round-trippable representation without rounding to a display precision.
  const [coefficient, exponent = "0"] = Math.abs(amount).toString().split("e");
  const [whole, fraction = ""] = coefficient.split(".");
  const digits = whole + fraction;
  const point = whole.length + Number(exponent);
  const integer = point <= 0 ? "0" : digits.slice(0, point).padEnd(point, "0");
  const decimals = point <= 0 ? "0".repeat(-point) + digits : digits.slice(point);
  const grouped = integer.replace(/\B(?=(\d{3})+(?!\d))/g, ",");
  const sign = amount < 0 || Object.is(amount, -0) ? "-" : "";
  return formatDigits(sign + grouped + (decimals ? "." + decimals : ""), options);
}

function validDate({ calendar, year, month, day }: CalendarDate): boolean {
  if (!Number.isSafeInteger(year) || year < 1) return false;
  if (month === undefined) return day === undefined;
  if (!Number.isInteger(month) || month < 1 || month > 12) return false;
  if (day === undefined) return true;
  if (!Number.isInteger(day) || day < 1) return false;
  if (calendar === "hijri") return day <= 30;
  const leapYear = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
  const days = [31, leapYear ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
  return day <= days[month - 1];
}

export function formatDate(date: CalendarDate, options: Presentation): string {
  if (!validDate(date)) throw new RangeError("Invalid calendar date");

  const { calendar, year, month, day } = date;
  const { language, dateStyle } = options;
  const era = calendar === "hijri" ? (language === "ar" ? " هـ" : " AH") : "";
  if (dateStyle === "iso") {
    const parts = [String(year).padStart(4, "0")];
    if (month !== undefined) parts.push(String(month).padStart(2, "0"));
    if (day !== undefined) parts.push(String(day).padStart(2, "0"));
    return formatDigits(parts.join("-"), options) + era;
  }

  const yearText = formatDigits(String(year), options) + era;
  if (month === undefined) return yearText;
  const monthName = (calendar === "hijri" ? hijriMonths : gregorianMonths)[language][month - 1];
  if (day === undefined) return `${monthName} ${yearText}`;
  const dayText = formatDigits(String(day), options);
  if (language === "ar") return `${dayText} ${monthName.replace(/^ذو /u, "ذي ")} ${yearText}`;
  return dateStyle === "day-first"
    ? `${dayText} ${monthName} ${yearText}`
    : `${monthName} ${dayText}, ${yearText}`;
}
