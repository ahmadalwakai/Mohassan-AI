import type { Capability, SkillToolId } from '@mohassan/contracts';

export type ToolState = { available: true } | { available: false; reason: string };
export interface PermissionSnapshot { tools: Readonly<Record<SkillToolId, ToolState>>; model: boolean; executable: boolean }
export interface SkillEnvironment { capabilities: readonly Capability[]; modelReady: boolean; visionReady: boolean; executableReady: boolean }

/** A tool is only as available as the capability behind it. Registration alone grants nothing. */
const CAPABILITY_OF: Readonly<Partial<Record<SkillToolId, string>>> = Object.freeze({
  'browser.open': 'browser.open', 'browser.interact': 'browser.research', 'browser.submit': 'browser.research', 'research.run': 'browser.research',
  'coding.change': 'coding.change', 'studio.change': 'studio.change', 'computer.view': 'device.remote', 'computer.act': 'device.remote', 'memory.search': 'memory.skills',
});
/** Tools the gateway does not provide yet stay refused here until it does. */
const NOT_IMPLEMENTED: ReadonlySet<SkillToolId> = new Set<SkillToolId>(['file.read', 'file.write']);

export function buildPermissionSnapshot(environment: SkillEnvironment): PermissionSnapshot {
  const statuses = new Map(environment.capabilities.map((capability) => [capability.id, capability.status]));
  const state = (tool: SkillToolId): ToolState => {
    if (NOT_IMPLEMENTED.has(tool)) return { available: false, reason: 'الأداة غير منفذة بعد.' };
    if (tool === 'vision.inspect') return environment.modelReady && environment.visionReady ? { available: true } : { available: false, reason: 'نموذج الرؤية غير مهيأ.' };
    const status = statuses.get(CAPABILITY_OF[tool]!);
    if (status === 'active') return { available: true };
    return { available: false, reason: status === 'needs_configuration' ? 'القدرة تحتاج إعداداً.' : 'القدرة غير متاحة.' };
  };
  const tools = Object.fromEntries(([...Object.keys(CAPABILITY_OF), 'vision.inspect', ...NOT_IMPLEMENTED] as SkillToolId[]).map((tool) => [tool, state(tool)])) as Record<SkillToolId, ToolState>;
  return { tools, model: environment.modelReady, executable: environment.executableReady };
}
