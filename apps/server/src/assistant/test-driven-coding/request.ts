export interface TestDrivenCodingRequest {
  description: string;
  assertions: string;
}

const assignment = /^(?:(?:please|kindly|(?:can|could|would) you|hello|hi)[ ,]+)*(?:write|implement|define|create|build|provide|develop|design|generate|make|complete)\b|^(?:(?:لو سمحت|من فضلك)[ ،]+)?(?:اكتب|برمج|أنشئ|انشئ|نفّذ|نفذ|عرّف|عرف)(?!\p{L})/iu;
const functionRequest = /\b(?:function|python)\b|(?:^|[^\p{L}])(?:دالة|داله|بايثون)(?!\p{L})/iu;
const assertion = /^[\t ]*(?:[-*+][\t ]+)?assert\b/mu;

export function parseTestDrivenCodingRequest(text: string): TestDrivenCodingRequest | null {
  if (text.length > 4_000) return null;
  const firstAssertion = assertion.exec(text);
  if (!firstAssertion?.index) return null;
  const before = text.slice(0, firstAssertion.index).trim();
  if (!assignment.test(before) || !functionRequest.test(before.split(/\r?\n/u, 1)[0]!)) return null;
  const openingFence = /(?:^|\n)[\t ]*(```+)(?:python|py)?[\t ]*$/iu.exec(before);
  let assertions = text.slice(firstAssertion.index).trimEnd();
  if (openingFence) {
    const closingFence = new RegExp(`\\r?\\n[\\t ]*${openingFence[1]}[\\t ]*$`, 'u');
    assertions = assertions.replace(closingFence, '');
  }
  const description = openingFence ? before.slice(0, openingFence.index).trimEnd() : before;
  return { description, assertions };
}

export function testDrivenCodingEnabled(): boolean {
  return process.env.TEST_DRIVEN_CODING_ENABLED === 'true';
}
