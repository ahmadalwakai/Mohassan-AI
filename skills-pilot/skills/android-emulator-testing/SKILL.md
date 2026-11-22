---
name: اختبار تطبيق أندرويد على المحاكي
description: يوجّه اختبار مسار في تطبيق أندرويد على المحاكي بأوامر adb: تثبيت البناء، وتشغيل النشاط، والنقر والكتابة بإحداثيات من شجرة الواجهة، والتقاط الشاشة وسجل logcat. كلمات: اختبار تطبيق أندرويد المحاكي adb تثبيت التطبيق logcat لقطة شاشة شجرة الواجهة android emulator testing qa adb install uiautomator screencap
category: coding
version: 1.0.0
language: ar
license: Apache-2.0
source: openai/plugins@981b02c0c44058b595f3b4180002c3ae3c806d40:plugins/test-android-apps/skills/android-emulator-qa/SKILL.md
source-sha256: 0ce182ad60db73ea663f0eab6793f4fbf63b4b4e2ebba596a61b7b3b8985eeac
attribution: Adapted from "android-emulator-qa" from openai/plugins test-android-apps (Apache-2.0). Changed: rewritten as a short Arabic playbook; bundled scripts and examples not included.
---
اختبار يُعاد بالأوامر نفسها أصدق من تجربة يدوية.

## متى تُستخدم
- عند التحقق من ميزة في تطبيق أندرويد، أو إعادة إنتاج خلل في الواجهة.

## ما أحتاجه منك
- اسم الحزمة، ونوع البناء، والمسار المراد اختباره.

## الخطوات
1. تأكد من تشغيل المحاكي: adb devices.
2. ثبّت البناء: ./gradlew :app:installDebug.
3. اعرف النشاط الرئيسي وشغّله: adb shell am start -n <الحزمة>/<النشاط>.
4. اقرأ شجرة الواجهة (uiautomator dump) لتعرف إحداثيات العناصر.
5. نفّذ المسار: adb shell input tap وadb shell input text.
6. التقط صورة بعد كل خطوة مهمة، واحفظ سجل logcat للتطبيق.
7. أعد التطبيق إلى حالة نظيفة بين الاختبارات: pm clear.

## شكل الجواب
- الأوامر بالترتيب، والنتيجة المتوقعة لكل خطوة، والأدلة.

## تحقق قبل التسليم
- هل تكرر الاختبار بالنتيجة نفسها من حالة نظيفة؟

## أخطاء شائعة
- إحداثيات ثابتة لا تأتي من شجرة الواجهة.
