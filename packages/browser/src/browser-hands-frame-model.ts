import { BROWSER_HANDS_FORM_GUARD_SCRIPT } from './browser-hands-agent.js';
import { BROWSER_HANDS_FRAME_SCRIPT } from './browser-hands-frame.js';

/** Decorate the browser's trusted, document-local model. Site text never contributes script. */
export function browserHandsFrameModel(baseModel: string): string {
  return String.raw`(() => {
    const base = ${baseModel};
    ${BROWSER_HANDS_FRAME_SCRIPT}
    ${BROWSER_HANDS_FORM_GUARD_SCRIPT}
    const identities = new WeakMap();
    const written = new WeakMap();
    let targets = new Map();

    const allNodes = () => {
      const nodes = [];
      const walk = (root) => {
        for (const node of root.querySelectorAll('*')) {
          if (nodes.length > 9000) return;
          nodes.push(node);
          if (node.shadowRoot) walk(node.shadowRoot);
        }
      };
      walk(document);
      return nodes;
    };

    const identityOf = (node, legacyRef) => JSON.stringify([
      node.isContentEditable ? null : legacyRef, location.href, node.tagName, node.id, node.isContentEditable,
      node.getAttribute('contenteditable'), node.getAttribute('role'), node.getAttribute('onclick'), node.getAttribute('target'),
      node.href, node.getAttribute('name'), node.disabled, node.getAttribute('aria-disabled'),
      node.form?.action, node.form?.method, node.form?.enctype, node.form?.target,
      node.getAttribute('formaction'), node.getAttribute('formmethod'), node.getAttribute('formenctype'), node.getAttribute('formtarget'),
      browserHandsMetadata(node),
    ]);

    const resolve = ref => {
      const target = targets.get(ref);
      if (!target?.node.isConnected) return null;
      const { node, legacyRef, identity } = target;
      if (node.isContentEditable) {
        if (!node.matches('[contenteditable="true"],[contenteditable=""],[contenteditable="plaintext-only"],[role="textbox"]') || !browserHandsShown(node)) return null;
      } else if (!legacyRef || base.resolve(legacyRef) !== node) return null;
      return identity === identityOf(node, legacyRef) ? target : null;
    };

    const read = (firstRef, limit) => {
      const snapshot = base.read(firstRef, limit);
      const originals = new Map(snapshot.elements.map(element => [base.resolve(element.ref), element]));
      const nodes = allNodes();
      const candidates = nodes.filter(node => originals.has(node)
        || node.matches('[contenteditable="plaintext-only"]') && browserHandsShown(node)).slice(0, limit);
      const next = new Map();
      const elements = candidates.map((node, position) => {
        const original = originals.get(node), legacyRef = original?.ref;
        const identity = identityOf(node, legacyRef), prior = identities.get(node);
        const ref = prior?.identity === identity ? prior.ref : 'e' + (firstRef + position);
        const target = { ref, node, legacyRef, identity };
        const match = browserHandsMetadata(node, position);
        const field = match.field ?? (['text', 'identifier'].includes(original?.field) ? original.field : undefined);
        const rect = node.getBoundingClientRect();
        const hidden = match.humanOnly || match.control === 'file' || field && field !== 'text' && field !== 'identifier';
        const value = !hidden && 'value' in node && node.tagName !== 'BUTTON' && !['submit','button'].includes(node.type)
          ? browserHandsClean(node.value, 60) : '';
        next.set(ref, target);
        identities.set(node, target);
        return {
          ref, label: match.name.slice(0, 90), role: original?.role ?? match.role, field, match,
          ...(value ? { value } : {}),
          ...(original?.href ? { href: original.href } : {}),
          ...(original?.disabled || node.getAttribute('aria-disabled') === 'true' ? { disabled: true } : {}),
          inViewport: rect.bottom > 0 && rect.right > 0 && rect.top < innerHeight && rect.left < innerWidth,
        };
      });
      targets = next;
      const content = browserHandsContent(nodes);
      return { ...snapshot, elements, content, text: content.main,
        integrity: JSON.stringify([snapshot.integrity, snapshot.url, snapshot.title, content]) };
    };

    const prepareForm = input => {
      const target = input.ref ? resolve(input.ref) : null;
      if (input.ref && !target?.legacyRef) return null;
      const node = target?.node ?? document.activeElement;
      const submitter = node && ['BUTTON','INPUT'].includes(node.tagName) && node.type === 'submit';
      if (node?.form && (input.kind !== 'click' || submitter)) {
        const humanOnly = browserHandsAssociatedHumanField(node.form);
        if (humanOnly) return { humanOnly };
      }
      return base.prepareForm(target ? { ...input, ref: target.legacyRef } : input);
    };

    const canWrite = (ref, value, approved) => {
      const target = resolve(ref);
      if (!target) return false;
      const { node, legacyRef } = target;
      const choice = browserHandsCanWriteChoice(node, value, written);
      if (choice !== undefined) return choice;
      const current = browserHandsValue(node);
      return approved || current === value || !current || written.get(node) === current
        || node.tagName === 'SELECT' && legacyRef && base.canWrite(legacyRef, value, approved) || false;
    };

    const recordWrite = ref => {
      const target = resolve(ref);
      if (target) browserHandsRecordWrite(target.node, written);
    };
    return { read, resolve: ref => resolve(ref)?.node ?? null, prepareForm, canWrite, recordWrite, captureSample: base.captureSample };
  })()`;
}
