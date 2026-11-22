---
name: أداء تطبيقات React وNext.js
description: يوجّه مراجعة أداء تطبيقات React وNext.js وتحسينه بالأولوية: إزالة الانتظار المتتالي للطلبات، وتقليل حجم الحزمة، وأداء الخادم، وجلب البيانات، وتقليل إعادة الرسم. كلمات: أداء react بطء صفحة next.js تحسين الأداء حجم الحزمة إعادة الرسم جلب البيانات طلبات متتالية react performance nextjs optimization bundle size waterfalls rerender
category: coding
version: 1.0.0
language: ar
license: MIT
source: vercel-labs/agent-skills@5a37a6329fbad3666c3207392a6a7c0110e92efb:skills/react-best-practices/SKILL.md
source-sha256: 71ed7794962fa6e803ee83030517b5b93a9f70fbfeb431ec4535c5480a8d8355
attribution: Adapted from "react-best-practices" by Vercel (MIT, declared in the skill front matter). Changed: rewritten as a short Arabic playbook; bundled scripts and examples not included.
---
ابدأ بما يوفّر ثواني قبل ما يوفّر أجزاء من الثانية.

## متى تُستخدم
- عند بطء صفحة React أو Next.js، أو مراجعة كود قبل الإطلاق.

## ما أحتاجه منك
- الصفحة البطيئة، وقياس حالي إن وجد: زمن التحميل أو حجم الحزمة.

## الخطوات
1. أزل الانتظار المتتالي: شغّل الطلبات المستقلة معًا بـ Promise.all، وأخّر await إلى حيث تُستخدم النتيجة.
2. قلّل الحزمة: استورد من الملف مباشرة لا من ملفات التجميع، وحمّل المكونات الثقيلة عند الحاجة.
3. على الخادم: اجلب البيانات في مكونات الخادم، واستخدم Suspense لبث المحتوى.
4. في المتصفح: لا تكرر جلب البيانات نفسها في كل مكون؛ اجمعها وخزّنها مؤقتًا.
5. قلّل إعادة الرسم: اشتق القيم بدل تخزينها في state، وثبّت المراجع الممرَّرة.
6. قِس بعد كل تغيير، وأبقِ ما يحسّن القياس فقط.

## شكل الجواب
- المشكلات مرتبة بالأثر: حرجة، ثم عالية، ثم متوسطة، مع التعديل المقترح لكل منها.

## تحقق قبل التسليم
- هل لكل تحسين قياس قبل وبعد؟

## أخطاء شائعة
- تحسين إعادة الرسم بينما الصفحة تنتظر طلبات متتالية.
