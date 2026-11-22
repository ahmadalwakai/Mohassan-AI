---
name: إنهاء فرع تطوير ودمجه
description: يوجّه إنهاء العمل على فرع git بعد اكتمال الميزة: التحقق من الاختبارات، وتحديد الفرع الأساس، ثم الاختيار بين الدمج المحلي أو طلب الدمج أو الإبقاء، والتنظيف بعده. كلمات: إنهاء الفرع دمج الفرع طلب دمج فرع git فرع تطوير حذف الفرع بعد الدمج finish branch merge branch pull request cleanup worktree
category: coding
version: 1.0.0
language: ar
license: MIT
source: openai/plugins@981b02c0c44058b595f3b4180002c3ae3c806d40:plugins/superpowers/skills/finishing-a-development-branch/SKILL.md
source-sha256: 8db5a922b242dd4e1bf824cb91c13b3e8d8e8a86d6ceaf7f0774eb9cce909d65
attribution: Adapted from "finishing-a-development-branch" from obra/superpowers by Jesse Vincent (MIT), as packaged in openai/plugins. Changed: rewritten as a short Arabic playbook; bundled scripts and examples not included.
---
اختبارات خضراء، ثم قرار واضح، ثم تنظيف.

## متى تُستخدم
- عند اكتمال ميزة على فرع ونجاح اختباراتها، وقبل دمجها.

## ما أحتاجه منك
- اسم الفرع، والفرع الأساس، وهل يعمل أحد غيرك عليه.

## الخطوات
1. شغّل الاختبارات كلها؛ إن فشل شيء فأصلحه أولًا ولا تكمل.
2. حدد الفرع الأساس الذي تفرّع منه العمل.
3. اختر واحدًا: دمج محلي في الأساس، أو دفع الفرع وفتح طلب دمج، أو إبقاء الفرع كما هو.
4. عند الدمج المحلي: حدّث الأساس، وادمج، وشغّل الاختبارات مرة أخرى.
5. عند طلب الدمج: اكتب وصفًا بما تغير وكيف اختُبر.
6. نظّف بعد الدمج فقط: احذف الفرع ومجلد العمل المؤقت.

## شكل الجواب
- حالة الاختبارات، والخيار المختار، والأوامر خطوة بخطوة.

## تحقق قبل التسليم
- هل نجحت الاختبارات بعد الدمج لا قبله فقط؟

## أخطاء شائعة
- حذف الفرع قبل التأكد من وصول التغييرات.
