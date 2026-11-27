import { Button } from "@chakra-ui/react";
import { NewMemberPasswordSchema } from "@mohassan/contracts";
import { useId, useRef, useState, type FormEvent } from "react";

export function accountFailure(error: unknown) {
  return error instanceof Error && error.name !== "TypeError" ? error.message : "تعذر الاتصال بالخدمة. حاول مجددًا.";
}

export function AccountPasswordForm({ requireCurrent, disabled, submitLabel, successMessage, onSave, onCancel }: {
  requireCurrent?: boolean;
  disabled?: boolean;
  submitLabel: string;
  successMessage?: string;
  onSave: (passwords: { currentPassword: string; newPassword: string }) => Promise<void>;
  onCancel?: () => void;
}) {
  const hint = useId();
  const submitting = useRef(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [saved, setSaved] = useState(false);
  const locked = busy || disabled;
  const minimum = NewMemberPasswordSchema.minLength ?? undefined;
  const maximum = NewMemberPasswordSchema.maxLength ?? undefined;

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (disabled || submitting.current) return;
    const form = event.currentTarget;
    const values = new FormData(form);
    const currentPassword = String(values.get("currentPassword") ?? "");
    const newPassword = String(values.get("newPassword") ?? "");
    setSaved(false);
    if (requireCurrent && !currentPassword) { setError("أدخل كلمة المرور الحالية."); return; }
    if (!NewMemberPasswordSchema.safeParse(newPassword).success) { setError("تحقق من طول كلمة المرور الجديدة."); return; }
    if (newPassword !== values.get("confirmPassword")) { setError("كلمتا المرور غير متطابقتين."); return; }

    submitting.current = true;
    setBusy(true);
    setError("");
    try {
      await onSave({ currentPassword, newPassword });
      form.reset();
      setSaved(true);
    } catch (caught) {
      setError(accountFailure(caught));
    } finally {
      submitting.current = false;
      setBusy(false);
    }
  }

  return <form className="stack-form" onSubmit={submit} noValidate aria-busy={busy}>
    {requireCurrent ? <label>كلمة المرور الحالية<input name="currentPassword" type="password" dir="ltr" autoComplete="current-password" required disabled={locked} /></label> : null}
    <label>كلمة المرور الجديدة<input name="newPassword" type="password" dir="ltr" autoComplete="new-password" aria-describedby={hint} required minLength={minimum} maxLength={maximum} disabled={locked} /></label>
    <p id={hint}>من {minimum?.toLocaleString("ar")} إلى {maximum?.toLocaleString("ar")} حرفًا.</p>
    <label>تأكيد كلمة المرور الجديدة<input name="confirmPassword" type="password" dir="ltr" autoComplete="new-password" required minLength={minimum} maxLength={maximum} disabled={locked} /></label>
    {error ? <p className="inline-error" role="alert">{error}</p> : null}
    {saved && successMessage ? <p role="status">{successMessage}</p> : null}
    <Button className="primary-button" type="submit" loading={busy} loadingText="جارٍ الحفظ…" disabled={locked}>{submitLabel}</Button>
    {onCancel ? <Button type="button" variant="outline" disabled={busy} onClick={onCancel}>رجوع</Button> : null}
  </form>;
}
