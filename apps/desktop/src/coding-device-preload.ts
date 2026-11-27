import { ipcRenderer } from 'electron';

window.addEventListener('DOMContentLoaded', () => {
  const form = document.querySelector<HTMLFormElement>('#pair');
  const input = document.querySelector<HTMLInputElement>('#code');
  const button = document.querySelector<HTMLButtonElement>('#submit');
  const status = document.querySelector<HTMLElement>('#status');
  if (!form || !input || !button || !status) return;
  form.addEventListener('submit', async event => {
    event.preventDefault();
    if (button.disabled) return;
    button.disabled = true;
    status.textContent = 'جارٍ ربط هذا الجهاز…';
    try {
      const result = await ipcRenderer.invoke('coding-device:pair', input.value) as { ok: boolean; message: string };
      status.textContent = result.message;
      if (result.ok) {
        input.value = '';
        input.disabled = true;
        status.focus();
        return;
      }
    } catch {
      status.textContent = 'تعذر ربط هذا الجهاز.';
    }
    button.disabled = false;
    input.focus();
  });
});
