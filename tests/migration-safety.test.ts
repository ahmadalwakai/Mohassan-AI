import { fileURLToPath } from 'node:url';
import { relative } from 'node:path';
import { PGlite } from '@electric-sql/pglite';
import { Kysely, PGliteDialect } from 'kysely';
import ts from 'typescript';
import { expect, it, vi } from 'vitest';
import { createApplication } from '../apps/server/src/app.js';

const ledgers = ['schema_migrations', 'auth_schema_migrations'] as const;
type Ledger = typeof ledgers[number];
type Registration = { ledger: Ledger; version: string; site: ts.Node; sqlScopes: ts.Node[] };
type SqlException = { sql: string; source?: string };

// Add the exact SQL and a comment explaining why it is safe for deployed data.
// For a query builder, include the source expression as well as its compiled SQL.
const allowedDestructiveSql: Readonly<Partial<Record<string, readonly SqlException[]>>> = {
  // No existing migration needs an exception.
};

const database = vi.hoisted(() => ({ open: vi.fn() }));
vi.mock('@mohassan/database', async importOriginal => ({
  ...await importOriginal<typeof import('@mohassan/database')>(),
  createDatabase: database.open,
}));

function visit(node: ts.Node, callback: (node: ts.Node) => void | false) {
  if (callback(node) === false) return;
  ts.forEachChild(node, child => visit(child, callback));
}

function unwrap(node: ts.Node): ts.Node {
  while (ts.isAsExpression(node) || ts.isParenthesizedExpression(node)) node = node.expression;
  return node;
}

function stringValue(node: ts.Node | undefined): string | undefined {
  return node && ts.isStringLiteralLike(node) ? node.text : undefined;
}

function templateText(node: ts.Node): string | undefined {
  if (ts.isTemplateExpression(node)) {
    return node.head.text + node.templateSpans.map(span => ' ? ' + span.literal.text).join('');
  }
  return stringValue(node);
}

function method(node: ts.Node, name: string): node is ts.CallExpression & { expression: ts.PropertyAccessExpression } {
  return ts.isCallExpression(node) && ts.isPropertyAccessExpression(node.expression) && node.expression.name.text === name;
}

function* chainedCalls(node: ts.Node) {
  while (ts.isPropertyAccessExpression(node.parent) && ts.isCallExpression(node.parent.parent)) {
    node = node.parent.parent;
    yield node;
  }
}

function migrationBody(node: ts.Node) {
  for (let parent = node.parent; parent; parent = parent.parent) {
    if (ts.isBlock(parent) && ts.isFunctionLike(parent.parent)) return parent;
  }
}

const root = fileURLToPath(new URL('../', import.meta.url));

function location(node: ts.Node) {
  const source = node.getSourceFile();
  return `${relative(root, source.fileName)}:${source.getLineAndCharacterOfPosition(node.getStart()).line + 1}`;
}

function migrationSources() {
  const files = ts.sys.readDirectory(root, ['.ts', '.js', '.mts', '.mjs', '.cts', '.cjs', '.sql'],
    ['**/node_modules/**', '**/*.test.*', '**/*.spec.*', '**/*.d.ts'],
    ['apps/server/src/**/*', 'packages/*/src/**/*']);
  const sourceFiles = files.filter(path => !path.endsWith('.sql'));
  const program = ts.createProgram(sourceFiles, {
    allowJs: true, noLib: true, types: [], target: ts.ScriptTarget.ESNext,
    module: ts.ModuleKind.ESNext, moduleResolution: ts.ModuleResolutionKind.Bundler,
  });
  const checker = program.getTypeChecker();
  const projectSources = new Set(sourceFiles.map(path => program.getSourceFile(path)));

  function declaration(node: ts.Node) {
    let symbol = ts.isShorthandPropertyAssignment(node.parent) && node.parent.name === node
      ? checker.getShorthandAssignmentValueSymbol(node.parent)
      : checker.getSymbolAtLocation(node);
    if (symbol && symbol.flags & ts.SymbolFlags.Alias) symbol = checker.getAliasedSymbol(symbol);
    const value = symbol?.valueDeclaration;
    return value && projectSources.has(value.getSourceFile()) ? value : undefined;
  }

  function initializer(node: ts.Node | undefined) {
    const value = node && declaration(node);
    return value && ts.isVariableDeclaration(value) && value.initializer ? unwrap(value.initializer) : undefined;
  }

  const registrations: Registration[] = [];
  function record(site: ts.Node, ledger: Ledger, version: ts.Node | undefined) {
    let scope = site;
    while (scope.parent && !ts.isBlock(scope)) scope = scope.parent;
    const literal = stringValue(version) ?? stringValue(initializer(version));
    if (literal) {
      registrations.push({ site, ledger, version: literal, sqlScopes: [scope] });
      return;
    }

    // The skills migrator records each [version, statements] entry in a for-of loop.
    const binding = version && declaration(version);
    if (binding && ts.isBindingElement(binding) && ts.isArrayBindingPattern(binding.parent)) {
      const pattern = binding.parent;
      const loop = pattern.parent.parent.parent;
      const tuples = ts.isForOfStatement(loop) && (initializer(loop.expression) ?? unwrap(loop.expression));
      if (tuples && ts.isArrayLiteralExpression(tuples) && pattern.elements[0] === binding) {
        for (const tuple of tuples.elements) {
          const entry = unwrap(tuple);
          const id = ts.isArrayLiteralExpression(entry) && stringValue(entry.elements[0]);
          if (!id || !ts.isArrayLiteralExpression(entry) || !entry.elements[1]) {
            throw new Error(`Expected a [version, statements] entry at ${location(tuple)}`);
          }
          registrations.push({ site: entry, ledger, version: id, sqlScopes: [scope, entry] });
        }
        return;
      }
    }
    throw new Error(`Could not resolve the recorded version at ${location(site)}`);
  }

  function recordRawSql(node: ts.Node, sql: string) {
    for (const { table, sql: statement, tokens } of findMigrationLedgerInserts(sql)) {
      const columns = /\(([^()]+)\)\s*values\b/i.exec(statement)?.[1];
      const firstColumn = columns?.split(',')[0].trim().replaceAll('"', '').toLowerCase();
      const value = tokens[tokens.findIndex(token => token.text.toLowerCase() === 'values') + 2];
      const version = value && /^'((?:''|[^'])*)'$/.exec(value.text)?.[1].replaceAll("''", "'");
      // Raw registrations must expose a version literal or a single version interpolation.
      const interpolation = ts.isTemplateExpression(node) && node.templateSpans.length === 1
        ? node.templateSpans[0].expression : undefined;
      record(node, table, columns && firstColumn !== 'version' ? undefined
        : version ? ts.factory.createStringLiteral(version)
          : value?.text === '?' ? interpolation : undefined);
    }
  }

  for (const file of projectSources) {
    if (!file) continue;
    visit(file, node => {
      if (method(node, 'insertInto')) {
        const table = node.arguments[0];
        const ledger = (stringValue(table) ?? stringValue(initializer(table)))?.split('.').at(-1);
        if (ledger !== 'schema_migrations' && ledger !== 'auth_schema_migrations') return;
        const values = [...chainedCalls(node)].find(call => method(call, 'values'));
        const row = values?.arguments[0];
        const version = row && ts.isObjectLiteralExpression(row) && row.properties.find(
          prop => prop.name && (prop.name.getText() === 'version' || stringValue(prop.name) === 'version'),
        );
        record(node, ledger, version && ts.isPropertyAssignment(version) ? version.initializer
          : version && ts.isShorthandPropertyAssignment(version) ? version.name : undefined);
      } else {
        const sql = templateText(node);
        if (sql && /\b(?:auth_)?schema_migrations\b/i.test(sql) && /\binsert\b/i.test(sql)) {
          recordRawSql(node, sql);
        }
      }
    });
  }
  for (const path of files.filter(path => path.endsWith('.sql'))) {
    const sql = ts.sys.readFile(path)!;
    recordRawSql(ts.createSourceFile(path, sql, ts.ScriptTarget.Latest), sql);
  }

  return { registrations, declaration };
}

function inspectQueryBuilder(node: ts.Node) {
  if (method(node, 'dropTable')) return 'DROP TABLE';
  if (method(node, 'dropColumn')) return 'DROP COLUMN';
  if (method(node, 'setDataType')) return 'ALTER COLUMN TYPE';
  if (method(node, 'deleteFrom')) {
    const calls = [...chainedCalls(node)];
    if (calls.some(call => method(call, 'execute') || method(call, 'executeTakeFirst') || method(call, 'executeTakeFirstOrThrow'))
      && !calls.some(call => method(call, 'where') || method(call, 'whereRef'))) return 'DELETE without WHERE';
  }
}

function inspectMigrations() {
  const { registrations, declaration } = migrationSources();
  const versions = new Map<string, Registration>();
  const duplicates: string[] = [];
  for (const entry of registrations) {
    const previous = versions.get(entry.version);
    if (previous) duplicates.push(`${entry.version} at ${location(previous.site)} and ${location(entry.site)}`);
    versions.set(entry.version, entry);
  }
  expect(duplicates, 'Full migration version strings must be unique across both ledgers').toEqual([]);

  const failures = new Set<string>();
  const approved = new Set<string>();
  const specificScopes = new Set(registrations.flatMap(entry => entry.sqlScopes));
  for (const { version, sqlScopes, site } of registrations) {
    const seen = new Set<ts.Node>();
    function check(node: ts.Node, sql: string, reason: string) {
      const exception = allowedDestructiveSql[version]?.find(entry => (entry.source ?? entry.sql) === sql);
      if (exception) approved.add(exception.sql);
      else failures.add(`${location(node)} [${version}] ${reason}: ${sql}`);
    }

    function inspect(scope: ts.Node, shared = false) {
      if (seen.has(scope)) return;
      seen.add(scope);
      visit(scope, node => {
        if (shared && specificScopes.has(node)) return false;
        const sql = ts.isSourceFile(node) ? node.text : templateText(node);
        if (sql) {
          for (const finding of findDestructiveSql(sql)) check(node, finding.sql, finding.reason);
        }
        const builderIssue = inspectQueryBuilder(node);
        if (builderIssue) check(node, node.getText(), builderIssue);
        // Follow SQL arrays and helper functions referenced by the migration body.
        if (ts.isIdentifier(node)) {
          const value = declaration(node);
          if (value && ts.isVariableDeclaration(value) && value.initializer) inspect(value.initializer, shared);
          if (value && ts.isFunctionDeclaration(value) && value.body) inspect(value.body, shared);
        }
      });
    }
    sqlScopes.forEach(scope => inspect(scope));
    // Shared statements outside a version guard also run as part of the migration.
    const body = migrationBody(site);
    if (body) inspect(body, true);
  }
  expect([...failures], 'Destructive SQL declared by migrations').toEqual([]);
  return { registrations, approved };
}

it('applies every recorded migration and leaves both ledgers unchanged on restart', async () => {
  const { registrations, approved } = inspectMigrations();
  const client = new PGlite();
  const executedSql = new Set<string>();
  const db = new Kysely<any>({
    dialect: new PGliteDialect({ pglite: client }),
    log(event) {
      if (event.level === 'query') executedSql.add(event.query.sql);
    },
  });
  database.open.mockResolvedValue({ db, mode: 'embedded', close: async () => {} });
  const config = {
    authSecret: 'migration-safety-auth-secret'.padEnd(32, '!'),
    internalSecret: 'migration-safety-internal-secret'.padEnd(32, '!'),
    setupToken: 'migration-safety-setup-token',
    webOrigin: 'http://localhost:3000',
    production: false,
    runWorker: false,
    skillEngineEnabled: true,
  };

  async function boot() {
    const { app } = await createApplication(config);
    try {
      return await Promise.all(ledgers.map(ledger =>
        db.selectFrom(ledger).select(['version', 'applied_at']).orderBy('version').execute()));
    } finally {
      await app.close();
    }
  }

  try {
    await client.waitReady;
    const first = await boot();
    for (const [index, ledger] of ledgers.entries()) {
      const expected = registrations.filter(entry => entry.ledger === ledger).map(entry => entry.version).sort();
      expect(expected, ledger).not.toHaveLength(0);
      expect(first[index].map(row => row.version).sort(), ledger).toEqual(expected);
    }
    expect(await boot()).toEqual(first);
    const unsafe = [...executedSql].flatMap(sql => findDestructiveSql(sql))
      .filter(finding => !approved.has(finding.sql));
    expect(unsafe, 'Destructive SQL executed during server startup').toEqual([]);
  } finally {
    database.open.mockReset();
    await db.destroy();
  }
}, 60_000);

it('detects destructive statements in PostgreSQL migrations', () => {
  const statements = [
    ['DROP /* comment */ TABLE IF EXISTS legacy', 'DROP TABLE'],
    ['ALTER TABLE settings ADD COLUMN enabled boolean, DROP old_setting', 'DROP COLUMN'],
    ['ALTER TABLE settings DROP COLUMN IF EXISTS "old setting"', 'DROP COLUMN'],
    ['TRUNCATE TABLE settings', 'TRUNCATE'],
    ['ALTER TABLE settings ALTER COLUMN enabled SET DATA TYPE text', 'ALTER COLUMN TYPE'],
    ['WITH active AS (SELECT id FROM owners WHERE enabled) DELETE FROM settings USING active', 'DELETE without WHERE'],
    ['DELETE FROM settings USING (SELECT id FROM owners WHERE enabled) active', 'DELETE without WHERE'],
  ];
  for (const [sql, reason] of statements) {
    expect(findDestructiveSql(sql), sql).toEqual([{ sql, reason }]);
  }
  expect(findDestructiveSql("DO 'BEGIN EXECUTE ''DROP TABLE settings''; END'"))
    .toEqual([{ sql: 'DROP TABLE settings', reason: 'DROP TABLE' }]);
});

it('accepts filtered deletes and ignores keywords in constraints, quoted values, and comments', () => {
  expect(findDestructiveSql(`
    -- DROP TABLE settings;
    CREATE TABLE settings (owner_id text REFERENCES owners(id) ON DELETE CASCADE);
    ALTER TABLE settings DROP CONSTRAINT old_constraint, ALTER COLUMN owner_id DROP NOT NULL;
    DELETE FROM settings WHERE owner_id = 'TRUNCATE TABLE owners; DROP TABLE settings';
  `)).toEqual([]);
});

type SqlToken = { text: string; offset: number; end: number; depth: number };

function sqlTokens(sql: string): SqlToken[] {
  // Keep quoted values and names as single tokens so their contents cannot look like SQL keywords.
  const token = /\s+|--[^\n]*|\/\*|\$(?:[a-z_][a-z_0-9]*)?\$|e'(?:''|\\[\s\S]|[^'\\])*'|'(?:''|[^'])*'|"(?:""|[^"])*"|[a-z_][a-z_0-9$]*|[^\s]/iy;
  const comment = /\/\*|\*\//g;
  const result: SqlToken[] = [];
  let depth = 0;
  while (token.lastIndex < sql.length) {
    const offset = token.lastIndex;
    const match = token.exec(sql)![0];
    if (/^\s|^--/.test(match)) continue;
    if (match === '/*') {
      let nesting = 1;
      comment.lastIndex = token.lastIndex;
      for (let marker = comment.exec(sql); marker; marker = comment.exec(sql)) {
        nesting += marker[0] === '/*' ? 1 : -1;
        if (nesting === 0) break;
      }
      token.lastIndex = nesting === 0 ? comment.lastIndex : sql.length;
      continue;
    }
    if (match.startsWith('$') && match.endsWith('$') && match.length > 1) {
      const close = sql.indexOf(match, token.lastIndex);
      token.lastIndex = close < 0 ? sql.length : close + match.length;
    }
    if (match === ')') depth--;
    result.push({ text: sql.slice(offset, token.lastIndex), offset, end: token.lastIndex, depth });
    if (match === '(') depth++;
  }
  return result;
}

function sqlStatements(sql: string) {
  const statements: { sql: string; tokens: SqlToken[] }[] = [];
  let tokens: SqlToken[] = [];
  for (const token of sqlTokens(sql)) {
    if (token.text === ';' && token.depth === 0) {
      if (tokens.length) statements.push({ sql: sql.slice(tokens[0].offset, token.offset).trim(), tokens });
      tokens = [];
    } else {
      tokens.push(token);
    }
  }
  if (tokens.length) statements.push({ sql: sql.slice(tokens[0].offset, tokens.at(-1)!.end), tokens });
  return statements;
}

function quotedSql(value: string) {
  const delimiter = /^\$(?:[a-z_][a-z_0-9]*)?\$/i.exec(value)?.[0];
  if (delimiter) return value.slice(delimiter.length, -delimiter.length);
  if (value.startsWith("'")) return value.slice(1, -1).replaceAll("''", "'");
}

function findDestructiveSql(sql: string, procedural = false): { reason: string; sql: string }[] {
  return sqlStatements(sql).flatMap(statement => {
    const { tokens } = statement;
    const words = tokens.map(token => token.text.toLowerCase());
    const reasons = new Set<string>();
    const embeddedSql: string[] = [];
    for (const [index, word] of words.entries()) {
      if (procedural && word === 'execute' && tokens[index + 1]) {
        const body = quotedSql(tokens[index + 1].text);
        if (body) embeddedSql.push(body);
      }
      if (word === 'drop' && words[index + 1] === 'table') reasons.add('DROP TABLE');
      if (word === 'truncate' && (index === 0 || ['begin', 'then', 'else', 'loop'].includes(words[index - 1]))) {
        reasons.add('TRUNCATE');
      }
      if (word === 'alter' && words[index + 1] === 'table') {
        const depth = tokens[index].depth;
        let target = index + (words[index + 2] === 'if' && words[index + 3] === 'exists' ? 4 : 2);
        if (words[target] === 'only') target++;
        while (words[target + 1] === '.') target += 2;
        let action = target + (words[target + 1] === '*' ? 2 : 1);
        for (; action < words.length && tokens[action].depth === depth; action++) {
          if (words[action] === 'drop' && words[action + 1] !== 'constraint') reasons.add('DROP COLUMN');
          if (words[action] === 'alter') {
            const type = action + (words[action + 1] === 'column' ? 3 : 2);
            if (words[type] === 'type' || words.slice(type, type + 3).join(' ') === 'set data type') {
              reasons.add('ALTER COLUMN TYPE');
            }
          }
          while (action + 1 < words.length && tokens[action + 1].depth >= depth) {
            if (words[++action] === ',' && tokens[action].depth === depth) break;
          }
        }
      }
      if (word === 'delete' && words[index + 1] === 'from') {
        const depth = tokens[index].depth;
        let hasWhere = false;
        for (let next = index + 2; next < words.length && tokens[next].depth >= depth; next++) {
          if (tokens[next].depth !== depth) continue;
          if (words[next] === 'returning' || words[next] === ';') break;
          if (words[next] === 'where') hasWhere = true;
        }
        if (!hasWhere) reasons.add('DELETE without WHERE');
      }
    }
    const matches = [...reasons].map(reason => ({ reason, sql: statement.sql }));
    if (words[0] === 'do') {
      const body = tokens.map(token => quotedSql(token.text)).find(value => value !== undefined);
      if (body) matches.push(...findDestructiveSql(body, true));
    }
    for (const body of embeddedSql) matches.push(...findDestructiveSql(body));
    return matches;
  });
}

function findMigrationLedgerInserts(sql: string): { table: Ledger; sql: string; tokens: SqlToken[] }[] {
  return sqlStatements(sql).flatMap(statement => {
    const words = statement.tokens.map(token => token.text.toLowerCase());
    return words.flatMap((word, index) => {
      if (word !== 'insert' || words[index + 1] !== 'into') return [];
      let target = index + (words[index + 2] === 'only' ? 3 : 2);
      while (words[target + 1] === '.') target += 2;
      const table = words[target]?.replace(/^"|"$/g, '');
      return table === 'schema_migrations' || table === 'auth_schema_migrations' ? [{ table, sql: statement.sql, tokens: statement.tokens }] : [];
    });
  });
}
