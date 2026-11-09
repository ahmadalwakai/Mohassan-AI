import { describe, expect, it } from 'vitest';
import { projectInventoryFormat, renderProjectInventory } from '../apps/server/src/assistant/inventory.js';

const projects = [
  { id: 'one', name: 'مخطط "الفصول"' },
  { id: 'two', name: 'دفتر المكتبة' },
];

function render(request: string, inventory = projects) {
  const format = projectInventoryFormat(request);
  expect(format).not.toBeNull();
  return renderProjectInventory(inventory, format!);
}

describe('standalone coding project inventory', () => {
  it.each([
    'اعرض أسماء المشاريع البرمجية فقط.',
    'ما أسماء مشاريع البرمجة في مساحة العمل؟ الأسماء فقط.',
    'استعرض مشاريع البرمجة في مساحة عملي وأعد اسم المشروع وحده.',
    'اعرض أسماء المشاريع البرمجية المسجلة فقط.',
    'Please list the coding projects in my workspace, names only.',
  ])('renders names from the owned inventory for %s', request => {
    expect(render(request)).toBe(projects.map(project => project.name).join('\n'));
  });

  it('serializes original requested Arabic keys and escapes names', () => {
    const request = 'أجرِ جردًا للمشروع البرمجي المسجل في مساحة العمل. أعد كائن JSON بالمفتاحين «الاسم» و«المعرّف» فقط كما يظهر في القائمة، دون تعديل أو فتح مهمة.';
    expect(JSON.parse(render(request, projects.slice(0, 1)))).toEqual({ الاسم: projects[0]!.name, المعرّف: 'one' });
  });

  it('preserves explicit keys and array shape for multiple projects', () => {
    const request = 'List the workspace coding projects. Return a JSON array with keys "projectId" and "projectName" only.';
    expect(JSON.parse(render(request))).toEqual(projects.map(({ id, name }) => ({ projectId: id, projectName: name })));
  });

  it('renders JSON arrays of names, with no synthetic row for an empty inventory', () => {
    const request = 'Show the coding projects as a JSON array of project names.';
    expect(JSON.parse(render(request))).toEqual(projects.map(project => project.name));
    expect(render(request, [])).toBe('[]');
    expect(render('List coding projects, names only.', [])).toBe('لا توجد مشاريع برمجية مسجلة.');
  });

  it('requires a single real project for the explicit object shape', () => {
    const format = projectInventoryFormat('Show the coding project as a JSON object with name and id.')!;
    expect(format).not.toBeNull();
    expect(() => renderProjectInventory(projects, format)).toThrow(RangeError);
    expect(() => renderProjectInventory([], format)).toThrow(RangeError);
  });

  it.each([
    'List the coding projects in the workspace.',
    'Show my Studio sessions, names only.',
    'List local coding projects, names only, and update the README.',
    'List local coding projects, names only, without editing a file, and create a new task.',
    'List the coding projects, names only, and tell me the current time.',
    'اعرض أسماء المشاريع البرمجية فقط وافتح المشروع الأول.',
    'اعرض أسماء المشاريع البرمجية فقط. ما الوقت؟',
    'Update the coding project, then list projects as JSON.',
    'List the coding projects. Return JSON with keys "name" and "repository".',
  ])('leaves the general assistant path available for %s', request => {
    expect(projectInventoryFormat(request)).toBeNull();
  });
});
