import { useId, useLayoutEffect, useRef, useState, type FormEvent, type Ref } from "react";
import { ImagePlus, LoaderCircle, Play } from "lucide-react";
import type { ModelInfo, ModelRunRequest, ModelRunResponse } from "@mohassan/contracts";
import { modelsRequest } from "./models-api";
import styles from "./models-workspace.module.css";

const REASONS: Record<string, string> = {
  absent: "ملفاته غير موجودة على الخادم.", busy: "مشغّل النماذج مشغول بنموذج آخر، أعد المحاولة بعد قليل.", timeout: "انتهى الوقت قبل أن يجيب.",
  unhealthy: "تعذّر تشغيله.", unsupported: "لا يقبل هذا النوع من المدخلات.", incompatible: "ملفاته لا تطابق بصماتها المسجلة.",
  "invalid-input": "المدخلات غير مقبولة لهذا النموذج.", "memory-budget": "لا تكفي ذاكرة الخادم المخصصة له.", "gpu-locked": "بطاقة الرسوم محجوزة لتدريب.",
  "unknown-model": "لا يوجد نموذج بهذا المعرّف.",
};

type ImageInput = NonNullable<ModelRunRequest["image"]>;
type SelectedImage = { file: File; mimeType: ImageInput["mimeType"] };
type Draft = { text: string; passage: string };
const IMAGE_TYPES: ImageInput["mimeType"][] = ["image/png", "image/jpeg", "image/webp"];

async function encodeImage({ file, mimeType }: SelectedImage): Promise<ImageInput> {
  const bytes = new Uint8Array(await file.arrayBuffer());
  let binary = "";
  for (let index = 0; index < bytes.length; index += 0x8000) binary += String.fromCharCode(...bytes.subarray(index, index + 0x8000));
  return { mimeType, data: btoa(binary) };
}

export function ModelRunForm({ model, draft, onDraftChange, offline, formRef, onClose }: {
  model: ModelInfo;
  draft: Draft;
  onDraftChange: (draft: Draft) => void;
  offline: boolean;
  formRef: Ref<HTMLFormElement>;
  onClose: () => void;
}) {
  const [image, setImage] = useState<SelectedImage | null>(null);
  const [imageError, setImageError] = useState("");
  const [running, setRunning] = useState(false);
  const [runError, setRunError] = useState("");
  const [result, setResult] = useState<ModelRunResponse | null>(null);
  const activeRun = useRef<{ token: symbol; controller: AbortController } | null>(null);
  const imageErrorId = useId();
  const { text, passage } = draft;

  // The workspace keys this form by model. Leaving it invalidates even a response whose fetch already resolved.
  useLayoutEffect(() => () => {
    const request = activeRun.current;
    activeRun.current = null;
    request?.controller.abort();
  }, []);

  function chooseImage(file: File | null) {
    setImage(null);
    setImageError("");
    if (!file) return;
    const mimeType = IMAGE_TYPES.find(type => type === file.type);
    if (!mimeType) { setImageError("اختر صورة PNG أو JPEG أو WebP."); return; }
    // The run schema expects at least 16 base64 characters, which requires 10 bytes.
    if (file.size < 10) { setImageError("ملف الصورة فارغ أو صغير جدًا."); return; }
    if (file.size > 5_000_000) { setImageError("الصورة أكبر من 5 ميغابايت."); return; }
    setImage({ file, mimeType });
  }

  const ready = model.input === "image" ? Boolean(image)
    : Boolean(text.trim()) && (model.input !== "reading" || Boolean(passage.trim()));

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!ready || offline || activeRun.current) return;
    const token = Symbol();
    const controller = new AbortController();
    activeRun.current = { token, controller };
    setRunning(true);
    setRunError("");
    setResult(null);
    try {
      const body: ModelRunRequest = image ? { image: await encodeImage(image) }
        : model.input === "reading" ? { text, passage } : { text };
      if (activeRun.current?.token !== token) return;
      const response = await modelsRequest<ModelRunResponse>(`/api/models/${encodeURIComponent(model.id)}/run`, {
        method: "POST", body: JSON.stringify(body), signal: controller.signal,
      });
      if (activeRun.current?.token === token) setResult(response);
    } catch (error) {
      if (activeRun.current?.token === token) setRunError(error instanceof Error ? error.message : "تعذر تشغيل النموذج.");
    } finally {
      if (activeRun.current?.token === token) {
        activeRun.current = null;
        setRunning(false);
      }
    }
  }

  return <form ref={formRef} className={styles.form} onSubmit={event => void submit(event)} aria-label={`تجربة ${model.id}`} tabIndex={-1}>
    <h3>جرّب <bdi dir="ltr">{model.id}</bdi></h3>
    {model.input === "image" ? <label className={styles.field}><span><ImagePlus size={14} aria-hidden="true" />الصورة</span>
      <input type="file" accept={IMAGE_TYPES.join(",")} onChange={event => chooseImage(event.target.files?.[0] ?? null)}
        aria-invalid={Boolean(imageError)} aria-describedby={imageError ? imageErrorId : undefined} /></label> : null}
    {imageError ? <p id={imageErrorId} className="inline-error" role="alert">{imageError}</p> : null}
    {model.input === "reading" ? <label className={styles.field}><span>الفقرة</span>
      <textarea dir="auto" rows={5} value={passage} onChange={event => onDraftChange({ text, passage: event.target.value })} maxLength={6000} placeholder="الفقرة التي يجيب منها النموذج" /></label> : null}
    {model.input !== "image" ? <label className={styles.field}><span>{model.input === "reading" ? "السؤال" : "النص"}</span>
      <textarea dir="auto" rows={3} value={text} onChange={event => onDraftChange({ text: event.target.value, passage })} maxLength={4000} placeholder={model.input === "reading" ? "سؤال عن الفقرة" : "اكتب ما يقرؤه النموذج"} /></label> : null}
    <div className={styles.actions}>
      <button type="submit" className="primary-button" disabled={running || offline || !ready}>
        {running ? <LoaderCircle size={14} className="spin" aria-hidden="true" /> : <Play size={14} aria-hidden="true" />}{running ? "يعمل…" : "شغّل"}</button>
      <button type="button" className="secondary-button" onClick={onClose}>إغلاق</button>
    </div>
    {runError ? <p className="inline-error" role="alert">{runError}</p> : null}
    {result ? <div className={styles.result} role="status">
      <p className={result.ok ? styles.badgeOk : styles.badgeBad}>{result.ok ? `أجاب في ${(result.elapsedMs / 1000).toFixed(1)} ث` : REASONS[result.reason ?? ""] ?? "تعذّر تشغيله."}</p>
      {result.detail ? <p className={styles.task} dir="auto">{result.detail}</p> : null}
      {result.text ? <p className={styles.answer} dir="auto">{result.text}</p> : null}
      {result.output ? <details><summary>المخرج كما هو</summary><pre dir="ltr" className={styles.output}>{result.output}</pre></details> : null}
    </div> : null}
  </form>;
}
