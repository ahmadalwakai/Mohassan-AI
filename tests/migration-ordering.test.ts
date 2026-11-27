import { relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';
import { expect, it } from 'vitest';
import { startupOrder } from './fixtures/migration-startup-order.js';

const root = fileURLToPath(new URL('../', import.meta.url));
const ledgerNames = ['schema_migrations', 'auth_schema_migrations'] as const;
type Ledger = typeof ledgerNames[number];
type Claim = { ledger: Ledger; version: string; site: string };

// The base reused 007, 029 and 033. The later overlaps are legacy IDs accepted
// with full equality by the current migrators. Retrieved 2026-11-27.
// https://github.com/ahmadalwakai/Mohassan-AI/blob/29448aea3fa10d226ef82ec5bf0a65e723d6ec39/docs/MIGRATION-LEDGER-2026-11-25.md
// https://github.com/ahmadalwakai/Mohassan-AI/tree/c2a0ff765071657cf200b5ee7d12fabaad738c0b
const existingPrefixCollisions = {
  'schema_migrations/007': ['007_memory_learning_v1', '007_studio_ai_input'],
  'schema_migrations/029': ['029_chat_campaign_events', '029_chat_images'],
  'schema_migrations/033': ['033_chat_request_keys', '033_skill_retention'],
  'schema_migrations/035': ['035_chat_conversation_review', '035_notifications', '035_structured_memory'],
  'schema_migrations/036': ['036_reminders', '036_structured_memory'],
  'schema_migrations/037': ['037_member_data_rights', '037_notifications'],
  'schema_migrations/038': ['038_conversation_shares', '038_reminders'],
  'schema_migrations/044': ['044_monitor_alert_feedback', '044_smart_monitors_v2'],
  'schema_migrations/046': ['046_smart_monitor_decisions', '046_smart_monitor_visual_budget'],
};

function location(node: ts.Node) {
  const source = node.getSourceFile();
  const line = source.getLineAndCharacterOfPosition(node.getStart()).line + 1;
  return `${relative(root, source.fileName)}:${line}`;
}

function unwrap(node: ts.Node) {
  while (ts.isAsExpression(node) || ts.isParenthesizedExpression(node) || ts.isSatisfiesExpression(node)) {
    node = node.expression;
  }
  return node;
}

function literal(node: ts.Node | undefined) {
  return node && ts.isStringLiteralLike(node) ? node.text : undefined;
}

function method(node: ts.Node, names: readonly string[]): node is ts.CallExpression & { expression: ts.PropertyAccessExpression } {
  return ts.isCallExpression(node) && ts.isPropertyAccessExpression(node.expression) && names.includes(node.expression.name.text);
}

function* chainedCalls(node: ts.CallExpression) {
  while (ts.isPropertyAccessExpression(node.parent) && ts.isCallExpression(node.parent.parent)) {
    node = node.parent.parent;
    yield node;
  }
}

function versionProperty(node: ts.Node | undefined) {
  if (!node || !ts.isObjectLiteralExpression(node)) return;
  const property = node.properties.find(prop => prop.name?.getText() === 'version' || literal(prop.name) === 'version');
  if (property && ts.isPropertyAssignment(property)) return property.initializer;
  if (property && ts.isShorthandPropertyAssignment(property)) return property.name;
}

// The source scan catches registrations that a duplicate ID would silently skip on startup.
// Based on the registration scan in PR #7, retrieved 2026-11-27.
// https://github.com/ahmadalwakai/Mohassan-AI/blob/c39375ee6ca16de353a4884b32e715867052de23/tests/migration-safety.test.ts
function scanLedgerClaims() {
  const files = ts.sys.readDirectory(root, ['.ts', '.mts', '.cts', '.js', '.mjs', '.cjs', '.sql'],
    ['**/node_modules/**', '**/*.test.*', '**/*.spec.*', '**/*.d.ts'],
    ['apps/server/src/**/*', 'apps/worker/src/**/*', 'packages/*/src/**/*']);
  const ledgerFiles = files.filter(path => /\b(?:auth_)?schema_migrations\b/i.test(ts.sys.readFile(path) ?? ''));
  const scriptFiles = ledgerFiles.filter(path => !path.endsWith('.sql'));
  const program = ts.createProgram(scriptFiles, {
    allowJs: true, noLib: true, types: [], module: ts.ModuleKind.ESNext, moduleResolution: ts.ModuleResolutionKind.Bundler,
  });
  const checker = program.getTypeChecker();
  const recorded: Claim[] = [];
  const aliases: Claim[] = [];
  const references: Claim[] = [];
  const rawLedgerWrite = /\b(?:insert\s+into|update)\s+(?:"?\w+"?\s*\.\s*)?"?(?:auth_)?schema_migrations\b/i;

  function declaration(node: ts.Node | undefined) {
    if (!node || !ts.isIdentifier(node)) return;
    let symbol = ts.isShorthandPropertyAssignment(node.parent)
      ? checker.getShorthandAssignmentValueSymbol(node.parent) : checker.getSymbolAtLocation(node);
    if (symbol && symbol.flags & ts.SymbolFlags.Alias) symbol = checker.getAliasedSymbol(symbol);
    return symbol?.valueDeclaration;
  }

  function initializer(node: ts.Node | undefined) {
    const variable = declaration(node);
    return variable && ts.isVariableDeclaration(variable) && variable.initializer ? unwrap(variable.initializer) : undefined;
  }

  function versionClaims(ledger: Ledger, site: ts.Node, node: ts.Node | undefined): Claim[] {
    const version = literal(node) ?? literal(initializer(node));
    if (version) return [{ ledger, version, site: location(site) }];

    // The skills migrator declares each version in a [version, statements] tuple.
    const binding = declaration(node);
    if (binding && ts.isBindingElement(binding) && ts.isArrayBindingPattern(binding.parent)) {
      const loop = binding.parent.parent.parent.parent;
      if (ts.isForOfStatement(loop) && binding.parent.elements[0] === binding) {
        const entries = initializer(loop.expression) ?? unwrap(loop.expression);
        if (ts.isArrayLiteralExpression(entries)) {
          return entries.elements.map(entry => {
            const tuple = unwrap(entry);
            const version = ts.isArrayLiteralExpression(tuple) && literal(tuple.elements[0]);
            if (!version) throw new Error(`Expected a migration [version, statements] tuple at ${location(entry)}`);
            return { ledger, version, site: location(entry) };
          });
        }
      }
    }
    throw new Error(`Could not resolve migration ID at ${location(site)}`);
  }

  function visit(node: ts.Node) {
    if (method(node, ['insertInto', 'selectFrom', 'updateTable'])) {
      const table = (literal(node.arguments[0]) ?? literal(initializer(node.arguments[0])))?.split('.').at(-1);
      const ledger = ledgerNames.find(name => name === table);
      if (ledger) {
        const calls = [...chainedCalls(node)];
        if (node.expression.name.text === 'insertInto') {
          const values = calls.find(call => method(call, ['values']));
          recorded.push(...versionClaims(ledger, node, versionProperty(values?.arguments[0])));
        } else {
          const match = calls.find(call => method(call, ['where']) && literal(call.arguments[0]) === 'version');
          if (!match || literal(match.arguments[1]) !== '=') {
            throw new Error(`Expected a full migration ID equality check at ${location(node)}`);
          }
          const matches = versionClaims(ledger, match, match.arguments[2]);
          if (node.expression.name.text === 'updateTable') {
            const set = calls.find(call => method(call, ['set']));
            references.push(...versionClaims(ledger, node, versionProperty(set?.arguments[0])));
            aliases.push(...matches);
          } else {
            references.push(...matches);
          }
        }
      }
    }
    if ((ts.isStringLiteralLike(node) || ts.isTemplateHead(node)) && rawLedgerWrite.test(node.text)) {
      throw new Error(`Add raw SQL ledger registrations to the collision scan at ${location(node)}`);
    }
    ts.forEachChild(node, visit);
  }

  for (const path of scriptFiles) visit(program.getSourceFile(path)!);
  for (const path of ledgerFiles.filter(path => path.endsWith('.sql'))) {
    if (rawLedgerWrite.test(ts.sys.readFile(path) ?? '')) {
      throw new Error(`Add raw SQL ledger registrations to the collision scan at ${relative(root, path)}`);
    }
  }
  return { recorded, aliases, references };
}

it('keeps full migration IDs unique and allows only the deployed prefix overlaps', () => {
  const { recorded, aliases, references } = scanLedgerClaims();
  const claimsByVersion = new Map<string, Claim>();
  const versionsByPrefix = new Map<string, string[]>();
  for (const claim of [...recorded, ...aliases]) {
    const previous = claimsByVersion.get(claim.version);
    expect(previous, `${claim.version} claimed at ${previous?.site} and ${claim.site}`).toBeUndefined();
    claimsByVersion.set(claim.version, claim);

    const prefix = /^(\d{3})_/.exec(claim.version)?.[1];
    if (prefix) {
      const key = `${claim.ledger}/${prefix}`;
      versionsByPrefix.set(key, [...(versionsByPrefix.get(key) ?? []), claim.version]);
    }
  }

  expect(Object.fromEntries([...versionsByPrefix]
    .filter(([, versions]) => versions.length > 1)
    .map(([prefix, versions]) => [prefix, versions.sort()]))).toEqual(existingPrefixCollisions);
  const recordedLedgers = new Map(recorded.map(({ version, ledger }) => [version, ledger]));
  for (const { ledger, version, site } of references) {
    expect(recordedLedgers.get(version), `Unknown recorded migration ID ${version} at ${site}`).toBe(ledger);
  }

  expect(recorded.map(({ ledger, version }) => ledger === 'auth_schema_migrations' ? `auth:${version}` : version).sort())
    .toEqual([...startupOrder].sort());
});
