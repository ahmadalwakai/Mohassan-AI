import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import ts from 'typescript';
import type { ClientCall } from './types.js';

function chromeCalls(root: string): ClientCall[] {
  const directory = 'packages/chrome-extension';
  const manifest = JSON.parse(readFileSync(join(root, directory, 'manifest.json'), 'utf8'));
  const file = `${directory}/${manifest.background.service_worker}`;
  const source = ts.createSourceFile(file, readFileSync(join(root, file), 'utf8'), ts.ScriptTarget.Latest, true, ts.ScriptKind.JS);
  const helper = source.statements.find(node => ts.isFunctionDeclaration(node) && node.name?.text === 'api');
  if (!helper || !ts.isFunctionDeclaration(helper) || !helper.body) throw new Error(`${file}: missing API helper`);
  const prefix = /\bpath:\s*`([^`$]+)\$\{path\}`/.exec(helper.body.getText(source))?.[1];
  const methods = /\bmethod:\s*body === undefined \? '([A-Z]+)' : '([A-Z]+)'/.exec(helper.body.getText(source));
  if (!prefix || !methods) throw new Error(`${file}: update the inventory for the extension's API relay`);
  const [, readMethod, writeMethod] = methods;
  const calls: ClientCall[] = [];

  function visit(node: ts.Node) {
    if (ts.isCallExpression(node) && ts.isIdentifier(node.expression) && node.expression.text === 'api') {
      const line = source.getLineAndCharacterOfPosition(node.getStart(source)).line + 1;
      const [tab, path, body] = node.arguments;
      let route: string | undefined;
      if (path && ts.isStringLiteralLike(path)) route = path.text;
      if (path && ts.isTemplateExpression(path) && path.templateSpans.length === 1) {
        const [span] = path.templateSpans;
        if (ts.isPropertyAccessExpression(span.expression)) {
          const parameter = span.expression.name.text;
          route = `${path.head.text}:${parameter === 'jobId' ? 'id' : parameter}${span.literal.text}`;
        }
      }
      if (route === undefined) throw new Error(`${file}:${line}: unresolved extension API path`);
      const pairing = ts.isIdentifier(tab) && tab.text === 'next';
      calls.push({
        client: 'Chrome', method: body && body.getText(source) !== 'undefined' ? writeMethod : readMethod,
        path: `${prefix}${route}`, file, line,
        ...(pairing ? { memberVisible: true, note: 'The extension popup accepts the current tab, including a signed-in member tab.' } : {}),
      });
    }
    ts.forEachChild(node, visit);
  }
  visit(source);
  return calls;
}

function windowsCalls(root: string): ClientCall[] {
  const file = 'apps/windows/Companion.cs';
  const source = readFileSync(join(root, file), 'utf8');
  const method = /\bnew HttpRequestMessage\(HttpMethod\.(\w+),\s*path\)/.exec(source)?.[1].toUpperCase();
  if (!method) throw new Error(`${file}: missing HTTP method in the companion's request helper`);
  return [...source.matchAll(/\bawait\s+Post\s*\(/g)].map(call => {
    const line = source.slice(0, call.index).split('\n').length;
    const argumentsStart = call.index + call[0].length;
    const request = /^\s*"(\/[^"\r\n]+)"\s*,[^\r\n]+?,\s*(true|false)\s*\)/.exec(source.slice(argumentsStart));
    if (!request) throw new Error(`${file}:${line}: unresolved companion API call`);
    const [, path, authenticate] = request;
    return {
      client: 'Windows', method, path, file, line,
      note: authenticate === 'true' ? 'Paired-device bearer credential' : 'Owner-issued pairing code',
    };
  });
}

export function companionCalls(root: string): ClientCall[] {
  return [...chromeCalls(root), ...windowsCalls(root)];
}
