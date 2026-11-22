---
name: ترقية إصدار Expo SDK
description: يوجّه ترقية مشروع Expo إلى إصدار SDK أحدث وإصلاح تعارض الحزم: الترقية، والتشخيص بـ expo-doctor، وتنظيف الذاكرة المؤقتة، ومراجعة التغييرات الكاسرة، والاختبار. كلمات: ترقية expo تحديث sdk تعارض الحزم expo doctor expo upgrade sdk upgrade dependency conflicts breaking changes react native upgrade
category: coding
version: 1.0.0
language: ar
license: MIT
source: openai/plugins@981b02c0c44058b595f3b4180002c3ae3c806d40:plugins/expo/skills/upgrading-expo/SKILL.md
source-sha256: 373efb08acd4002922b1d6eb6dbfff6a871e38841f72f0753f4928650ed70ee1
attribution: Adapted from "upgrading-expo" by 650 Industries (Expo) (MIT), as packaged in openai/plugins. Changed: rewritten as a short Arabic playbook; bundled scripts and examples not included.
---
ترقية إصدار واحد في كل مرة أسهل من القفز عدة إصدارات.

## متى تُستخدم
- عند ترقية Expo SDK، أو بعد تحذير بحزم غير متوافقة.

## ما أحتاجه منك
- الإصدار الحالي والمطلوب، وقائمة الحزم الأصلية المستخدمة.

## الخطوات
1. احفظ نقطة رجوع في git قبل البدء.
2. رقِّ Expo: npx expo install expo@^<الإصدار>، ثم npx expo install --fix لمواءمة الحزم.
3. شخّص المشروع: npx expo-doctor، وأصلح كل تحذير.
4. نظّف الذاكرة المؤقتة وأعد التثبيت.
5. راجع ملاحظات الإصدار للتغييرات الكاسرة، وطبّقها واحدة واحدة.
6. ابنِ نسخة تطوير جديدة للحزم الأصلية، واختبر على iOS وأندرويد.

## شكل الجواب
- الأوامر بالترتيب، والتغييرات الكاسرة التي تخص مشروعك، وخطة الاختبار.

## تحقق قبل التسليم
- هل يعمل التطبيق على المنصتين بعد بناء جديد؟

## أخطاء شائعة
- ترقية عدة إصدارات دفعة واحدة.
