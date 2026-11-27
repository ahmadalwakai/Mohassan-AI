import ts from "typescript";
import type { CodingContextFile, EditRefusal } from "./edit-generator.ts";
import { credentialLike, editablePath, limits } from "./security.ts";
import { absolutePath, applyTextChanges, createSnapshot, diagnosticCounts } from "./typescript-repair.ts";

export type RenameRequest = { from: string; to: string; project?: string } | "incomplete";

const verb = /^\s*(?:(?:please|kindly|could you|can you|would you|من فضلك|لو سمحت|رجاء\p{M}*)[,،\s]+)*(?:rename|[أإآٱا]\p{M}*ع\p{M}*د\p{M}*\s+ت\p{M}*س\p{M}*م\p{M}*ي\p{M}*[هة]\p{M}*|غ\p{M}*ي\p{M}*ر\p{M}*\s+[أإآٱا]\p{M}*س\p{M}*م\p{M}*)(?=\s|$)/iu;
const unwrap = (text: string) => text.trim().replace(/^(?:`(.*)`|«(.*)»|"(.*)"|'(.*)')$/u, "$1$2$3$4").trim();

/** Parse an explicit rename without folding the spelling or case of either identifier. */
export function readRenameGoal(goal: string): RenameRequest | undefined {
  const prefix = verb.exec(goal);
  if (!prefix) return undefined;
  const instruction = goal.slice(prefix[0].length).trim();
  const parts = /^(\S.*?)\s+(?:[أإآٱا]\p{M}*ل\p{M}*[ىي]\p{M}*|to)\s+(\S.*)$/iu.exec(instruction);
  if (!parts) return "incomplete";
  const from = parts[1]!.replace(/^(?:the\s+)?(?:function|identifier|variable|class|method|الدال[هة]|المعرّ?ف|المتغيّ?ر|الصنف)\s+/iu, "");
  const project = /\s+(?:في|in)\s+(.+)$/iu.exec(parts[2]!);
  const to = parts[2]!.slice(0, project?.index).replace(/[.!؟?،]$/u, "");
  return { from: unwrap(from), to: unwrap(to), ...(project ? { project: project[1]! } : {}) };
}

function validIdentifier(name: string): boolean {
  if (!/^[$_\p{ID_Start}][$_\u200c\u200d\p{ID_Continue}]*$/u.test(name)) return false;
  const scanner = ts.createScanner(ts.ScriptTarget.Latest, true, ts.LanguageVariant.Standard, name);
  const token = scanner.scan();
  return token === ts.SyntaxKind.Identifier || (token > ts.SyntaxKind.LastFutureReservedWord && token <= ts.SyntaxKind.LastKeyword
    && token !== ts.SyntaxKind.AwaitKeyword);
}

function refusal(reason: string): EditRefusal {
  return { kind: "refused", code: "NO_PROVEN_FIX", reason: `تعذرت إعادة التسمية: ${reason}` };
}

function displayName(name: string): string {
  return credentialLike(name) ? "الاسم المحدد" : `«${name.slice(0, 100)}»`;
}

function isDeclaration(node: ts.Identifier, checker: ts.TypeChecker): boolean {
  const parent = node.parent;
  // These occurrences can link to an existing declaration even when TypeScript creates a symbol for the name.
  if (ts.isShorthandPropertyAssignment(parent) || ts.isExportSpecifier(parent)
    || (ts.isImportSpecifier(parent) && !parent.propertyName)) return false;
  return checker.getSymbolAtLocation(node)?.declarations?.some((declaration) => (declaration as ts.NamedDeclaration).name === node) ?? false;
}

function exportsName(checker: ts.TypeChecker, module: ts.Node, name: string): boolean {
  const symbol = checker.getSymbolAtLocation(module);
  return Boolean(symbol && checker.getExportsOfModule(symbol).some((item) => item.getName() === name));
}

function memberType(node: ts.ClassLikeDeclaration | ts.EnumDeclaration, checker: ts.TypeChecker, staticSide: boolean): ts.Type {
  const symbol = checker.getSymbolAtLocation(node.name ?? node);
  if (staticSide && symbol) return checker.getTypeOfSymbolAtLocation(symbol, node);
  const type = checker.getTypeAtLocation(node);
  return !staticSide && ts.isClassExpression(node) ? type.getConstructSignatures()[0]?.getReturnType() ?? type : type;
}

function nameCollision(node: ts.Node, name: string, checker: ts.TypeChecker, location: ts.RenameLocation): boolean {
  const parent = node.parent;
  if ((ts.isPropertyAccessExpression(parent) && parent.name === node)
    || (ts.isElementAccessExpression(parent) && parent.argumentExpression === node)) {
    return Boolean(checker.getPropertyOfType(checker.getTypeAtLocation(parent.expression), name));
  }
  if (ts.isQualifiedName(parent) && parent.right === node) {
    const symbol = checker.getSymbolAtLocation(parent.left);
    const target = symbol && (symbol.flags & ts.SymbolFlags.Alias ? checker.getAliasedSymbol(symbol) : symbol);
    return Boolean(target && checker.getExportsOfModule(target).some((item) => item.getName() === name));
  }
  if (ts.isImportSpecifier(parent)) {
    if (parent.name === node && checker.resolveName(name, node, ts.SymbolFlags.Alias | ts.SymbolFlags.Value | ts.SymbolFlags.Type, false)) return true;
    return node !== parent.name || (!parent.propertyName && !location.prefixText)
      ? exportsName(checker, parent.parent.parent.parent.moduleSpecifier, name) : false;
  }
  if (ts.isExportSpecifier(parent)) {
    const source = parent.parent.parent.moduleSpecifier;
    if (parent.name === node && !location.suffixText && exportsName(checker, node.getSourceFile(), name)) return true;
    if (source && (parent.propertyName === node || !parent.propertyName)) return exportsName(checker, source, name);
  }
  if ((ts.isPropertyDeclaration(parent) || ts.isPropertySignature(parent) || ts.isMethodDeclaration(parent)
    || ts.isMethodSignature(parent) || ts.isAccessor(parent) || ts.isPropertyAssignment(parent) || ts.isEnumMember(parent)) && parent.name === node) {
    const owner = parent.parent;
    if (ts.isPropertyAssignment(parent) && name === "__proto__") return true;
    const type = ts.isClassLike(owner) || ts.isEnumDeclaration(owner)
      ? memberType(owner, checker, ts.isEnumDeclaration(owner) || Boolean(ts.getCombinedModifierFlags(parent) & ts.ModifierFlags.Static))
      : checker.getTypeAtLocation(owner);
    return Boolean(checker.getPropertyOfType(type, name));
  }
  if (ts.isIdentifier(node) && isDeclaration(node, checker) && (ts.getCombinedModifierFlags(parent as ts.Declaration) & ts.ModifierFlags.Export)) {
    const scope = ts.isVariableDeclaration(parent) ? parent.parent.parent.parent : parent.parent;
    if (ts.isModuleBlock(scope) && exportsName(checker, scope.parent.name, name)) return true;
    if (ts.isSourceFile(scope) && exportsName(checker, scope, name)) return true;
  }
  return Boolean(checker.resolveName(name, node, ts.SymbolFlags.Value | ts.SymbolFlags.Type | ts.SymbolFlags.Namespace | ts.SymbolFlags.Alias, false));
}

/** Build an all-or-nothing edit against the same registered snapshot the engine will verify. */
export function renameTypeScript(files: readonly CodingContextFile[], request: RenameRequest, signal: AbortSignal, project?: string) {
  signal.throwIfAborted();
  if (request === "incomplete") return refusal("حدّد الاسم الحالي والاسم الجديد في طلب واحد.");
  const { from, to } = request;
  const oldName = displayName(from), newName = displayName(to);
  if (!validIdentifier(to)) return refusal(`الاسم الجديد ${newName} ليس معرّف TypeScript صالحًا.`);
  if (from === to) return refusal("الاسم الجديد يطابق الاسم الحالي.");

  const snapshot = createSnapshot(files, false, signal, project, true);
  try {
    if (!snapshot.configValid) return refusal("تعذّر تحليل إعدادات TypeScript المحفوظة.");
    const program = snapshot.service.getProgram();
    if (!program) return refusal("تعذّر تحليل ملفات المشروع باستخدام TypeScript.");
    const checker = program.getTypeChecker();
    const registered = new Map(files.map((file) => [absolutePath(file.path), file]));
    const declarations: ts.Identifier[] = [];
    const memberScopes: (ts.ClassLikeDeclaration | ts.InterfaceDeclaration)[] = [];
    const tokens = new Map<string, Map<number, ts.Node>>();
    for (const source of program.getSourceFiles()) {
      signal.throwIfAborted();
      const path = absolutePath(source.fileName);
      if (!registered.has(path)) continue;
      const positions = new Map<number, ts.Node>();
      tokens.set(path, positions);
      const visit = (node: ts.Node) => {
        if (ts.isClassLike(node) || ts.isInterfaceDeclaration(node)) memberScopes.push(node);
        if (ts.isIdentifier(node) && node.text === from) {
          positions.set(node.getStart(source), node);
          if (isDeclaration(node, checker)) declarations.push(node);
        } else if (ts.isStringLiteralLike(node) && node.text === from) {
          positions.set(node.getStart(source) + 1, node);
        }
        ts.forEachChild(node, visit);
      };
      visit(source);
    }
    if (!declarations.length) return refusal(`لم أجد تصريحًا للمعرّف ${oldName} في ملفات المشروع.`);
    if (declarations.length !== 1) return refusal(`وجدت أكثر من تصريح للمعرّف ${oldName} في ملفات المشروع.`);

    const declaration = declarations[0]!;
    if (from === "__proto__" && ts.isPropertyAssignment(declaration.parent)) {
      return refusal("الاسم الحالي يحدد النموذج الأولي للكائن في JavaScript، ولا يمكن إعادة تسميته بأمان.");
    }
    const source = declaration.getSourceFile().fileName;
    const start = declaration.getStart();
    const collision = () => refusal(`الاسم الجديد ${newName} موجود بالفعل في النطاق.`);
    const locations = snapshot.service.getRenameInfo(source, start, { allowRenameOfImportPath: false }).canRename
      ? snapshot.service.findRenameLocations(source, start, false, false, { providePrefixAndSuffixTextForRename: true }) : undefined;
    if (!locations?.some((location) => location.fileName === source && location.textSpan.start === start)) {
      return refusal(`لم يتمكّن TypeScript من تحديد مواضع إعادة تسمية ${oldName}.`);
    }
    const changes = new Map<string, ts.TextChange[]>();
    for (const location of locations) {
      signal.throwIfAborted();
      const path = absolutePath(location.fileName);
      const file = registered.get(path);
      if (!file) return refusal("تتطلب إعادة التسمية تعديل ملف محمي خارج الملفات المسجّلة.");
      if (!file.editable || !editablePath(file.path)) return refusal(`تتطلب إعادة التسمية تعديل ملف محمي «${file.path}».`);
      const token = tokens.get(path)?.get(location.textSpan.start);
      if (!token) return refusal("تعذّر التحقق من أحد مواضع إعادة التسمية باستخدام TypeScript.");
      if (nameCollision(token, to, checker, location)) return collision();
      const edits = changes.get(path) ?? [];
      edits.push({ span: location.textSpan, newText: `${location.prefixText ?? ""}${to}${location.suffixText ?? ""}` });
      changes.set(path, edits);
    }
    const member = declaration.parent;
    if (ts.isClassLike(member.parent) || ts.isInterfaceDeclaration(member.parent)) {
      const staticSide = Boolean(ts.getCombinedModifierFlags(member as ts.Declaration) & ts.ModifierFlags.Static);
      for (const scope of memberScopes) {
        const type = ts.isClassLike(scope) ? memberType(scope, checker, staticSide) : checker.getTypeAtLocation(scope);
        if (checker.getPropertyOfType(type, from)?.declarations?.some((item) => item === member)
          && checker.getPropertyOfType(type, to)) return collision();
      }
    }

    const edits = [];
    const updated = new Map<string, string>();
    let bytes = 0;
    for (const [path, changesInFile] of changes) {
      const file = registered.get(path)!;
      const content = applyTextChanges(file.content, changesInFile);
      if (content === undefined || content === file.content || content.includes("\0") || credentialLike(content)) {
        return refusal("تعذّر إنشاء تعديلات نصية آمنة لمواضع إعادة التسمية.");
      }
      const size = Buffer.byteLength(content);
      bytes += size;
      if (size > limits.fileBytes || bytes > limits.editsBytes) return refusal("تجاوزت تعديلات إعادة التسمية حدّ الحجم المسموح.");
      updated.set(path, content);
      edits.push({ path: file.path, expectedHash: file.hash, content });
    }
    const before = diagnosticCounts(snapshot.diagnostics());
    snapshot.update(updated);
    const after = diagnosticCounts(snapshot.diagnostics());
    if ([...after].some(([diagnostic, count]) => count > (before.get(diagnostic) ?? 0))) {
      return refusal("زادت تشخيصات TypeScript بعد تجربة إعادة التسمية في الذاكرة.");
    }
    return { summary: `أُعيدت تسمية ${oldName} إلى ${newName} دون زيادة تشخيصات TypeScript.`, edits };
  } finally { snapshot.service.dispose(); }
}
