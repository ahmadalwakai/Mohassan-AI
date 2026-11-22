---
name: أداء قاعدة بيانات Postgres
description: يوجّه تحسين أداء Postgres: قراءة خطة الاستعلام، والفهارس المناسبة، وتجميع الاتصالات، وأداء سياسات أمان الصفوف، وتصميم الجداول. كلمات: أداء postgres استعلام بطيء فهرس explain analyze تجميع الاتصالات أمان الصفوف قاعدة بيانات بطيئة rls supabase postgresql performance slow query index connection pooling
category: coding
version: 1.0.0
language: ar
license: MIT
source: openai/plugins@981b02c0c44058b595f3b4180002c3ae3c806d40:plugins/supabase/skills/supabase-postgres-best-practices/SKILL.md
source-sha256: ccd6e4596bd51cf344fe76c464867c541ccc16b6d90ae7a9db449fb17588613b
attribution: Adapted from "supabase-postgres-best-practices" by Supabase (MIT), as packaged in openai/plugins. Changed: rewritten as a short Arabic playbook; bundled scripts and examples not included.
---
لا تخمّن سبب البطء؛ خطة الاستعلام تقوله.

## متى تُستخدم
- عند استعلام بطيء، أو تصميم جداول جديدة، أو ضغط اتصالات على القاعدة.

## ما أحتاجه منك
- الاستعلام البطيء، وبنية الجداول، وحجم البيانات.

## الخطوات
1. شغّل EXPLAIN ANALYZE واقرأ أبطأ عقدة: مسح كامل؟ ترتيب في الذاكرة؟
2. أضف فهرسًا للأعمدة المستخدمة في WHERE وJOIN وORDER BY، وفهرسًا مركبًا بترتيب الأعمدة الصحيح.
3. اختر النوع المناسب: B-tree للمقارنات، وGIN لبيانات JSON والنصوص.
4. استخدم تجميع الاتصالات (pooler) عند كثرة الاتصالات القصيرة.
5. في سياسات أمان الصفوف: فهرس الأعمدة المستخدمة فيها، وتجنب الدوال البطيئة لكل صف.
6. أعد القياس بعد كل تغيير وقارن الخطة.

## شكل الجواب
- السبب من خطة الاستعلام، والتعديل (فهرس أو إعادة كتابة)، والقياس قبل وبعد.

## تحقق قبل التسليم
- هل تستخدم الخطة الجديدة الفهرس فعلًا؟

## أخطاء شائعة
- فهرس لكل عمود دون قياس، فتبطؤ الكتابة.
