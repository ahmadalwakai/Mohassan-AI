---
name: أداء تطبيقات React Native
description: يوجّه تحسين أداء تطبيقات React Native وExpo: القوائم الطويلة والتمرير، والحركات، والصور، وتحميل الخطوط والوحدات الأصلية، والقياس على جهاز حقيقي. كلمات: أداء react native تطبيق بطيء قائمة طويلة تمرير متقطع حركة بطيئة صور expo flashlist reanimated react native performance list scroll animation memory
category: coding
version: 1.0.0
language: ar
license: MIT
source: vercel-labs/agent-skills@5a37a6329fbad3666c3207392a6a7c0110e92efb:skills/react-native-skills/SKILL.md
source-sha256: 4012750a5ccbe064ca04af3835d5d1b011979d2d09d9b6df1c8128fac58e0a66
attribution: Adapted from "react-native-skills" by Vercel (MIT, declared in the skill front matter). Changed: rewritten as a short Arabic playbook; bundled scripts and examples not included.
---
تطبيق الجوال يُحكم عليه بسلاسة التمرير والحركة.

## متى تُستخدم
- عند تمرير متقطع، أو حركة بطيئة، أو تطبيق React Native يستهلك الذاكرة.

## ما أحتاجه منك
- الشاشة البطيئة، والجهاز الذي تظهر عليه المشكلة، وحجم البيانات.

## الخطوات
1. للقوائم الطويلة: استخدم قائمة افتراضية مثل FlashList بدل ScrollView.
2. ثبّت عناصر القائمة بـ memo، وثبّت الدوال الممررة إليها.
3. شغّل الحركات على الطبقة الأصلية (Reanimated) لا في JavaScript.
4. حمّل الصور بأبعاد العرض الفعلية، وخزّنها مؤقتًا.
5. حمّل الخطوط والوحدات الأصلية مرة واحدة عند الإقلاع.
6. قِس على جهاز حقيقي متوسط وبنسخة إنتاج، لا على المحاكي وحده.

## شكل الجواب
- المشكلات مرتبة بالأثر، مع التعديل لكل منها وطريقة قياسه.

## تحقق قبل التسليم
- هل قيس التحسين على جهاز حقيقي وبنسخة إنتاج؟

## أخطاء شائعة
- الحكم على الأداء من وضع التطوير.
