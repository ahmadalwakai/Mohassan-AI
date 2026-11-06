import { SkillToolIdSchema, type Capability, type SkillToolId } from '@mohassan/contracts';

export type ToolState = { available: true } | { available: false; reason: string };
export interface PermissionSnapshot { tools: Readonly<Record<SkillToolId, ToolState>>; model: boolean; executable: boolean }
export interface SkillEnvironment { capabilities: readonly Capability[]; modelReady: boolean; visionReady: boolean; executableReady: boolean; gatewayTools?: readonly SkillToolId[] }

/** A tool is only as available as the capability behind it. Registration alone grants nothing. */
export const skillToolCapabilities: Readonly<Partial<Record<SkillToolId, string>>> = Object.freeze({
  'browser.open': 'browser.open', 'browser.interact': 'browser.research', 'browser.submit': 'browser.research', 'research.run': 'browser.research',
  'coding.change': 'coding.change', 'studio.change': 'studio.change', 'computer.view': 'device.remote', 'computer.act': 'device.remote', 'memory.search': 'memory.skills',
});
export function buildPermissionSnapshot(environment: SkillEnvironment): PermissionSnapshot {
  const statuses = new Map(environment.capabilities.map((capability) => [capability.id, capability.status]));
  const state = (tool: SkillToolId): ToolState => {
    if (environment.gatewayTools && !environment.gatewayTools.includes(tool)) return { available: false, reason: 'لا يوجد محول تنفيذ مهيأ لهذه الأداة.' };
    if (tool === 'file.read' || tool === 'file.write') return environment.gatewayTools?.includes(tool) ? {available: true} : {available: false, reason: 'أداة الملفات غير مهيأة.'};
    if (tool === 'vision.inspect') return environment.modelReady && environment.visionReady ? { available: true } : { available: false, reason: 'نموذج الرؤية غير مهيأ.' };
    const status = statuses.get(skillToolCapabilities[tool]!);
    if (status === 'active') return { available: true };
    return { available: false, reason: status === 'needs_configuration' ? 'القدرة تحتاج إعداداً.' : 'القدرة غير متاحة.' };
  };
  const tools = Object.fromEntries(SkillToolIdSchema.options.map((tool) => [tool, state(tool)])) as Record<SkillToolId, ToolState>;
  return { tools, model: environment.modelReady, executable: environment.executableReady };
}
