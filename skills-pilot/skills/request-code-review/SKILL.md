---
name: تجهيز طلب مراجعة كود
description: يوجّه تجهيز طلب مراجعة كود يسهل على المراجع: متى تطلب المراجعة، وحجم التغيير، والوصف، وأدلة الاختبار، وما تريد أن يركز عليه المراجع. كلمات: طلب مراجعة الكود تجهيز طلب الدمج وصف التغيير قبل الدمج مراجعة مبكرة request code review pull request description before merge reviewer focus
category: coding
version: 1.0.0
language: ar
license: MIT
source: openai/plugins@981b02c0c44058b595f3b4180002c3ae3c806d40:plugins/superpowers/skills/requesting-code-review/SKILL.md
source-sha256: d71cc01ba56d2325cf8af5f7c11837819b63ecd57de0bfdb812f7f3ff7751df8
attribution: Adapted from "requesting-code-review" from obra/superpowers by Jesse Vincent (MIT), as packaged in openai/plugins. Changed: rewritten as a short Arabic playbook; bundled scripts and examples not included.
---
راجِع مبكرًا وكثيرًا؛ المراجعة الصغيرة تُقرأ فعلًا.

## متى تُستخدم
- بعد ميزة كبيرة، وقبل الدمج في الفرع الرئيسي، وعند التعثر.

## ما أحتاجه منك
- التغيير ونطاقه، والمتطلب الذي يحققه.

## الخطوات
1. اجعل الطلب صغيرًا: تغيير واحد متماسك، وأقل من 400 سطر إن أمكن.
2. راجع الفرق بنفسك أولًا، وأزل التعديلات العرضية.
3. اكتب الوصف: ماذا تغير، ولماذا، وما الذي لم يتغير.
4. أرفق دليل الاختبار: الأوامر التي شُغّلت ونتيجتها.
5. حدد للمراجع ما تريد أن يركز عليه، والمواضع التي تشك فيها.
6. اربط الطلب بالمتطلب أو المشكلة الأصلية.

## شكل الجواب
- عنوان الطلب، والوصف، وأدلة الاختبار، ونقاط التركيز.

## تحقق قبل التسليم
- هل يفهم المراجع التغيير من الوصف دون أن يسألك؟

## أخطاء شائعة
- طلب ضخم يخلط إعادة الهيكلة بالميزة.
