import type { SkillCompositionRequest, SkillContract, SkillPlanIssue } from '@mohassan/contracts';

type FieldType = SkillContract['inputs'][number]['type'];

export interface ComposedGraph { batches: string[][]; issues: SkillPlanIssue[]; precedes: (before: string, after: string) => boolean; ordered: (a: string, b: string) => boolean }

const issue = (code: string, nodeId: string | null, message: string): SkillPlanIssue => ({ code, severity: 'error', category: 'invalid_plan', nodeId, message });

export function assignable(from: FieldType, to: FieldType): boolean {
  return from === to || to === 'json' || (to === 'string' && (from === 'url' || from === 'file'));
}

/** Kahn's algorithm by level: each batch can run together, and whatever is left over is a cycle. */
export function layers(ids: readonly string[], dependencies: ReadonlyMap<string, ReadonlySet<string>>): { batches: string[][]; cyclic: string[] } {
  const remaining = new Set(ids), batches: string[][] = [];
  while (remaining.size) {
    const ready = [...remaining].filter((id) => ![...(dependencies.get(id) ?? [])].some((dependency) => remaining.has(dependency))).sort();
    if (!ready.length) return { batches, cyclic: [...remaining].sort() };
    batches.push(ready);
    for (const id of ready) remaining.delete(id);
  }
  return { batches, cyclic: [] };
}

function reachability(ids: readonly string[], dependencies: ReadonlyMap<string, ReadonlySet<string>>) {
  const ancestors = new Map<string, Set<string>>();
  const visit = (id: string, trail: Set<string>): Set<string> => {
    const known = ancestors.get(id);
    if (known) return known;
    if (trail.has(id)) return new Set();
    trail.add(id);
    const found = new Set<string>();
    for (const dependency of dependencies.get(id) ?? []) { found.add(dependency); for (const ancestor of visit(dependency, trail)) found.add(ancestor); }
    trail.delete(id);
    ancestors.set(id, found);
    return found;
  };
  for (const id of ids) visit(id, new Set());
  return (before: string, after: string) => before !== after && Boolean(ancestors.get(after)?.has(before));
}

/** The steps inside one skill follow the same rules as the nodes between skills. */
export function validateStepGraph(contract: SkillContract, nodeId: string | null): SkillPlanIssue[] {
  const issues: SkillPlanIssue[] = [];
  const steps = new Map(contract.steps.map((step) => [step.id, step]));
  const inputs = new Map(contract.inputs.map((field) => [field.name, field]));
  const dependencies = new Map(contract.steps.map((step) => [step.id, new Set(step.dependsOn)]));
  for (const step of contract.steps) {
    for (const [name, binding] of Object.entries(step.inputs)) {
      const separator = binding.indexOf('.');
      const source = binding.slice(0, separator), field = binding.slice(separator + 1);
      if (separator < 1) { issues.push(issue('step_binding_invalid', nodeId, `ربط غير صالح في الخطوة ${step.id}: ${name}`)); continue; }
      if (source === 'input') {
        if (!inputs.has(field)) issues.push(issue('step_binding_unknown', nodeId, `الخطوة ${step.id} تطلب مدخلاً غير معلن: ${field}`));
        continue;
      }
      const from = steps.get(source);
      if (!from?.outputs.some((output) => output.name === field)) { issues.push(issue('step_binding_unknown', nodeId, `الخطوة ${step.id} تطلب ناتجاً غير موجود: ${binding}`)); continue; }
      if (source === step.id) issues.push(issue('step_cycle', nodeId, `الخطوة ${step.id} تعتمد على نفسها.`));
      else dependencies.get(step.id)!.add(source);
    }
  }
  const { cyclic } = layers([...steps.keys()], dependencies);
  if (cyclic.length) issues.push(issue('step_cycle', nodeId, `دورة بين الخطوات: ${cyclic.join('، ')}`));
  return issues;
}

/** Decides structure only. Nothing here touches the database, a tool or the model. */
export function composeSkillGraph(request: SkillCompositionRequest, contracts: ReadonlyMap<string, SkillContract>): ComposedGraph {
  const issues: SkillPlanIssue[] = [];
  const nodes = new Map(request.nodes.map((node) => [node.id, node]));
  const planInputs = new Map(request.inputs.map((field) => [field.name, field]));
  if (nodes.size !== request.nodes.length) issues.push(issue('duplicate_node', null, 'معرفات العقد يجب أن تكون فريدة.'));
  if (planInputs.size !== request.inputs.length) issues.push(issue('duplicate_input', null, 'أسماء مدخلات الخطة يجب أن تكون فريدة.'));
  const dependencies = new Map<string, Set<string>>();

  for (const node of nodes.values()) {
    const required = new Set(node.dependsOn);
    dependencies.set(node.id, required);
    if (node.id === 'input') issues.push(issue('reserved_node_id', node.id, 'المعرف input محجوز لمدخلات الخطة.'));
    for (const dependency of node.dependsOn) {
      if (dependency === node.id) issues.push(issue('self_dependency', node.id, 'لا يمكن أن تعتمد العقدة على نفسها.'));
      else if (!nodes.has(dependency)) issues.push(issue('unknown_dependency', node.id, `اعتماد على عقدة غير موجودة: ${dependency}`));
    }
    const contract = contracts.get(node.id);
    if (!contract) continue;
    const accepted = new Map(contract.inputs.map((field) => [field.name, field]));
    for (const [name, binding] of Object.entries(node.inputs)) {
      const target = accepted.get(name);
      if (!target) { issues.push(issue('unknown_input', node.id, `المهارة لا تقبل المدخل ${name}.`)); continue; }
      const separator = binding.indexOf('.');
      const source = binding.slice(0, separator), field = binding.slice(separator + 1);
      let type: FieldType | undefined;
      if (source === 'input') {
        type = planInputs.get(field)?.type;
        if (!type) { issues.push(issue('unknown_plan_input', node.id, `مدخل الخطة غير معلن: ${field}`)); continue; }
      } else {
        if (!nodes.has(source)) { issues.push(issue('unknown_dependency', node.id, `ربط بعقدة غير موجودة: ${source}`)); continue; }
        if (source === node.id) { issues.push(issue('self_dependency', node.id, 'لا يمكن ربط العقدة بناتجها.')); continue; }
        required.add(source);
        const sourceContract = contracts.get(source);
        if (!sourceContract) continue;
        type = sourceContract.outputs.find((output) => output.name === field)?.type;
        if (!type) { issues.push(issue('unknown_output', node.id, `لا تنتج العقدة ${source} الناتج ${field}.`)); continue; }
      }
      if (!assignable(type, target.type)) issues.push(issue('type_mismatch', node.id, `النوع ${type} لا يناسب المدخل ${name} من النوع ${target.type}.`));
    }
    for (const field of contract.inputs) if (field.required && !(field.name in node.inputs)) issues.push(issue('missing_input', node.id, `المدخل المطلوب ${field.name} غير مربوط.`));
    issues.push(...validateStepGraph(contract, node.id));
  }

  const { batches, cyclic } = layers([...nodes.keys()], dependencies);
  if (cyclic.length) issues.push(issue('cycle', null, `دورة بين العقد: ${cyclic.join('، ')}`));
  const precedes = reachability([...nodes.keys()], dependencies);
  // Resource conflicts only need serialization; required skills need a particular direction.
  const ordered = (a: string, b: string) => precedes(a, b) || precedes(b, a);

  for (const node of nodes.values()) {
    const contract = contracts.get(node.id);
    for (const slug of contract?.dependsOn ?? []) {
      const providers = [...nodes.values()].filter((candidate) => contracts.get(candidate.id)?.slug === slug);
      if (!providers.length) issues.push({ code: 'missing_skill_dependency', severity: 'error', category: 'missing_skill', nodeId: node.id, message: `تعتمد المهارة على ${slug}، وهي ليست في الخطة.` });
      else if (!providers.some((provider) => precedes(provider.id, node.id))) issues.push(issue('skill_dependency_unordered', node.id, `يجب أن تعمل ${slug} قبل هذه العقدة.`));
    }
  }
  return { batches, issues, precedes, ordered };
}
