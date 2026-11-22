---
name: نشر تطبيق Expo على متجري أبل وجوجل
description: يوجّه نشر تطبيق Expo وReact Native على App Store وGoogle Play: إعداد EAS، وبناء الإنتاج، والتجربة عبر TestFlight، والإرسال، وبيانات المتجر. كلمات: نشر تطبيق expo رفع التطبيق على المتجر app store google play testflight eas build eas submit إصدار التطبيق expo deployment release app store submission
category: coding
version: 1.0.0
language: ar
license: MIT
source: openai/plugins@981b02c0c44058b595f3b4180002c3ae3c806d40:plugins/expo/skills/expo-deployment/SKILL.md
source-sha256: 81b700b0cfe12ac175d4f64d052464db5f7ddc40e8a29cba52c642d87acee0dd
attribution: Adapted from "expo-deployment" by 650 Industries (Expo) (MIT), as packaged in openai/plugins. Changed: rewritten as a short Arabic playbook; bundled scripts and examples not included.
---
النشر خطوات ثابتة؛ معظم الرفض سببه بيانات ناقصة لا الكود.

## متى تُستخدم
- عند إصدار تطبيق Expo للمرة الأولى، أو إصدار تحديث للمتجر.

## ما أحتاجه منك
- حساب مطور أبل وجوجل، ومعرّف الحزمة، ورقم الإصدار.

## الخطوات
1. ثبّت أداة EAS وسجّل الدخول، ثم هيّئ المشروع: eas build:configure.
2. اضبط eas.json بملف للإنتاج، واجعل رقم البناء يزيد تلقائيًا.
3. ابنِ نسختي الإنتاج: eas build --platform all --profile production.
4. جرّب نسخة iOS عبر TestFlight، ونسخة أندرويد عبر الاختبار الداخلي.
5. أرسل إلى المتجرين: eas submit لكل منصة.
6. جهّز بيانات المتجر: الوصف، والصور، وسياسة الخصوصية، وتصنيف المحتوى.
7. تابع المراجعة، وأصلح أسباب الرفض إن وُجدت ثم أعد الإرسال.

## شكل الجواب
- الأوامر بالترتيب، وقائمة بيانات المتجر المطلوبة لكل منصة.

## تحقق قبل التسليم
- هل جُرّبت نسخة الإنتاج نفسها قبل الإرسال؟

## أخطاء شائعة
- نسيان رفع رقم البناء، فيُرفض الإرسال.
