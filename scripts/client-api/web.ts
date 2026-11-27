import { readdirSync, readFileSync } from "node:fs";
import { basename, join, posix, relative, sep } from "node:path";
import ts from "typescript";
import type { ClientCall } from "./types.js";

type CallSignature = {
  path?: number;
  pathWrapper?: string;
  options?: number;
  body?: number;
  methodArg?: number;
  method?: string;
  optionsBody?: boolean;
};

// These describe transport wrappers, so their callers remain the source of the paths and methods.
const signatures: Record<string, CallSignature> = {
  fetch: { options: 1 },
  EventSource: {},
  api: { options: 1 },
  request: { options: 1 },
  accountRequest: { options: 1 },
  accountResponse: { options: 1 },
  useAccountResource: {},
  requestMetrics: { options: 1 },
  reminderRequest: { options: 1 },
  notificationRequest: { options: 1 },
  notificationPost: { method: "POST" },
  shareFetch: { options: 1 },
  shareJson: { path: 1, options: 2 },
  saveProject: { method: "POST" },
  skillRequest: { options: 2 },
  skillPost: { method: "POST" },
  useSkillResource: {},
  boundedRequest: { options: 3 },
  inviteRequest: { body: 1 },
  post: { method: "POST" },
  ownsNotification: {},
};
const localSignatures: Record<string, CallSignature> = {
  "assistant-app.tsx:post": { pathWrapper: "post", method: "POST" },
  "chrome-extension-panel.tsx:request": { pathWrapper: "request", body: 1 },
  "chrome-extension-panel.tsx:change": { pathWrapper: "request", method: "POST" },
  "desktop-workspace.tsx:api": { body: 1, methodArg: 2 },
  "google-ads-workspace.tsx:api": { pathWrapper: "api", body: 1 },
  "learning-panel.tsx:request": { body: 1 },
  "members.tsx:api": { body: 1 },
  "public-index-panel.tsx:api": { methodArg: 1 },
  "sites-workspace.tsx:api": { options: 1, optionsBody: true },
  "smart-monitors-v2.tsx:monitorRequest": { pathWrapper: "monitorRequest", options: 2, optionsBody: true },
  "windows-workspace.tsx:api": { body: 1 },
};

// The browser's own fetch is the sink for these wrappers. Their callers supply the URL.
const fetchWrappers = new Set([
  "accountResponse", "api", "inviteRequest", "monitorRequest", "notificationRequest", "ownsNotification", "post",
  "reminderRequest", "request", "requestMetrics", "saveProject", "shareFetch", "skillRequest",
]);

const memberComponents = new Set([
  "assistant-app.tsx", "assistant-notifications.tsx", "background-notification-client.ts",
  "browser-files-panel.tsx", "browser-viewport.tsx", "conversation-actions.tsx",
  "documents-panel.tsx", "google-ads-workspace.tsx", "member-data-rights.tsx", "monitors-client.ts",
  "notification-client.ts", "notification-settings.tsx", "notifications-sw.js", "reminders-settings.tsx",
  "sites-workspace.tsx", "smart-monitors.tsx", "smart-monitors-v2.tsx", "alert-feedback.tsx",
]);

// Paths delivered in responses cannot be statically followed from the consuming JSX alone.
const responseLinks = [
  {
    file: "apps/web/components/browser-viewport.tsx", expression: "source",
    producer: "apps/server/src/command-chat.ts", pattern: /screenUrl: `([^`]+)`/,
  },
  {
    file: "apps/web/components/sites-workspace.tsx", expression: "`\${site.previewPath}",
    producer: "apps/server/src/sites.ts", pattern: /const previewPath = .*=> `([^`]+)`/,
    suffix: "*",
  },
  {
    file: "apps/web/components/assistant-app.tsx", expression: "item.url",
    producer: "apps/server/src/command-chat.ts", pattern: /expiresAt: expiresAt\.toISOString\(\), url: `([^`]+)`/,
  },
  {
    file: "apps/web/components/browser-open-result.tsx", expression: "screenshot",
    producer: "apps/server/src/browser-task.ts", pattern: /screenshotUrl: image \? `([^`]+)`/,
  },
  {
    file: "apps/web/components/studio-ai-panel.tsx", expression: "image.url",
    producer: "apps/server/src/studio-ai.ts", pattern: /expiresAt:expiresAt\.toISOString\(\),url:`([^`]+)`/,
  },
  {
    file: "apps/web/components/conversation-actions.tsx", expression: "url.value", attribute: "value",
    producer: "apps/server/src/conversation-share.ts", pattern: /{ share, url: new URL\(`([^`]+)`/,
    transport: "next",
  },
  {
    file: "apps/web/components/studio-live-panel.tsx", expression: "live.url",
    producer: "apps/server/src/studio-live.ts", pattern: /\.localhost:\$\{port\}(\/p\/[^`]+)`/,
    transport: "external",
  },
] satisfies Array<{file: string; expression: string; producer: string; pattern: RegExp; attribute?: string; suffix?: string; transport?: ClientCall["transport"]}>;

const routeNotes: Record<string, string> = {
  "POST /api/chat/images": "The attachment button is shown to members (apps/web/components/assistant-app.tsx:653), whose access description can advertise images (apps/server/src/members.ts:140).",
  "POST /api/sites/:param/publish": "MemberTools mounts SitesWorkspace (apps/web/components/members.tsx:209), and its Publish button uses availability returned for every role (apps/web/components/sites-workspace.tsx:219, apps/server/src/sites.ts:292).",
  "GET /api/desktop/screenshot": "The client reads x-desktop-capture (apps/web/components/desktop-workspace.tsx:175), but the relay omits this server response header (apps/server/src/desktop.ts:162, apps/web/app/api/[...path]/route.ts:44).",
  "GET /api/training-monitor": "The route returns 503 when owner-local training status files are unavailable (apps/server/src/training-monitor/route.ts:59).",
};

function webSources(root: string, directory: string): string[] {
  return readdirSync(join(root, directory), { withFileTypes: true }).flatMap(entry => {
    const path = posix.join(directory, entry.name);
    if (entry.isDirectory()) return webSources(root, path);
    return /\.(tsx?|js)$/.test(entry.name) && !entry.name.endsWith(".d.ts") ? [path] : [];
  });
}

function concatenate(parts: string[][]): string[] {
  return parts.reduce((prefixes, segments) => prefixes.flatMap(prefix => segments.map(segment => prefix + segment)), [""]);
}

function property(node: ts.Expression | undefined, name: string): ts.Expression | undefined {
  if (!node || !ts.isObjectLiteralExpression(node)) return undefined;
  for (const member of node.properties) {
    if (member.name?.getText().replace(/^["']|["']$/g, "") !== name) continue;
    if (ts.isPropertyAssignment(member)) return member.initializer;
    if (ts.isShorthandPropertyAssignment(member)) return member.name;
  }
  return undefined;
}

function owningFunction(node: ts.Node): string | undefined {
  for (let parent = node.parent; parent; parent = parent.parent) {
    if (ts.isFunctionDeclaration(parent)) return parent.name?.text;
    if (ts.isArrowFunction(parent) && ts.isVariableDeclaration(parent.parent)) return parent.parent.name.getText();
  }
  return undefined;
}

export function webCalls(root: string): ClientCall[] {
  const files = ["apps/web/app", "apps/web/components", "apps/web/lib", "apps/web/public"]
    .flatMap(directory => webSources(root, directory));
  const program = ts.createProgram(files.map(file => join(root, file)), {
    allowJs: true, noLib: true, types: [], jsx: ts.JsxEmit.Preserve,
    module: ts.ModuleKind.ESNext, moduleResolution: ts.ModuleResolutionKind.Bundler, skipLibCheck: true,
  });
  const checker = program.getTypeChecker();
  const calls: ClientCall[] = [];
  const dynamic = ":param";

  function declaration(node: ts.Node): ts.Declaration | undefined {
    let symbol = checker.getSymbolAtLocation(node);
    if (symbol && symbol.flags & ts.SymbolFlags.Alias) symbol = checker.getAliasedSymbol(symbol);
    return symbol?.valueDeclaration ?? symbol?.declarations?.[0];
  }

  function forwardsPath(node: ts.Node): boolean {
    if (ts.isIdentifier(node)) {
      const binding = declaration(node);
      return !!binding && ts.isParameter(binding) && binding.parent.parameters[0] === binding;
    }
    return !!ts.forEachChild(node, child => forwardsPath(child) || undefined);
  }

  function strings(node: ts.Expression | undefined, depth = 0): string[] {
    if (!node || depth > 12) return [dynamic];
    const expand = (child: ts.Expression | undefined) => strings(child, depth + 1);
    if (ts.isStringLiteralLike(node)) return [node.text];
    if (node.kind === ts.SyntaxKind.NullKeyword || node.getText() === "undefined") return [];
    if (ts.isParenthesizedExpression(node) || ts.isNonNullExpression(node) || ts.isAsExpression(node)) return expand(node.expression);
    if (ts.isTemplateExpression(node)) {
      return concatenate([[node.head.text], ...node.templateSpans.flatMap(span => [expand(span.expression), [span.literal.text]])]);
    }
    if (ts.isConditionalExpression(node)) {
      const values = [...expand(node.whenTrue), ...expand(node.whenFalse)];
      // The approve action uses the collection URL, and only the remaining actions use the detail URL.
      if (ts.isBinaryExpression(node.condition) && node.condition.operatorToken.kind === ts.SyntaxKind.EqualsEqualsEqualsToken
          && ts.isStringLiteralLike(node.condition.right)) {
        const excluded = node.condition.right.text;
        return values.filter(value => !value.endsWith(`/${excluded}`) || expand(node.whenTrue).includes(value));
      }
      return values;
    }
    if (ts.isBinaryExpression(node) && node.operatorToken.kind === ts.SyntaxKind.PlusToken) {
      return concatenate([expand(node.left), expand(node.right)]);
    }
    if (ts.isNewExpression(node) && node.expression.getText() === "URL") return expand(node.arguments?.[0]);
    if (ts.isCallExpression(node)) {
      const name = node.expression.getText();
      if (name === "encodeURIComponent") return expand(node.arguments[0]);
      if (name === "conversationPath") {
        const declared = declaration(node.expression);
        if (declared && ts.isVariableDeclaration(declared) && declared.initializer && ts.isArrowFunction(declared.initializer)
            && !ts.isBlock(declared.initializer.body)) return expand(declared.initializer.body);
      }
    }
    if (ts.isIdentifier(node) || ts.isPropertyAccessExpression(node)) {
      const declared = declaration(ts.isPropertyAccessExpression(node) ? node.name : node);
      if (declared && (ts.isVariableDeclaration(declared) || ts.isPropertyAssignment(declared)) && declared.initializer) {
        return expand(declared.initializer);
      }
      if (declared && ts.isParameter(declared)) {
        const type = checker.getTypeAtLocation(node);
        const variants = type.isUnion() ? type.types : [type];
        if (variants.every(variant => variant.isStringLiteral())) return variants.map(variant => variant.value);
        // A literal array of resource kinds is used in a JSX map callback.
        const callback = declared.parent;
        const arrayMethod = callback.parent;
        if (ts.isArrowFunction(callback) && callback.parameters[0] === declared && ts.isCallExpression(arrayMethod)
            && ts.isPropertyAccessExpression(arrayMethod.expression) && arrayMethod.expression.name.text === "map") {
          let receiver: ts.Expression = arrayMethod.expression.expression;
          while (ts.isParenthesizedExpression(receiver) || ts.isAsExpression(receiver)) receiver = receiver.expression;
          if (ts.isArrayLiteralExpression(receiver)) return receiver.elements.flatMap(expand);
        }
      }
    }
    return [dynamic];
  }

  function importContract(node: ts.Node | undefined): string | undefined {
    if (node && ts.isTypeReferenceNode(node)) node = node.typeName;
    if (!node || !ts.isIdentifier(node)) return undefined;
    const imported = checker.getSymbolAtLocation(node)?.declarations?.[0];
    if (!imported || !ts.isImportSpecifier(imported)) return undefined;
    const module = imported.parent.parent.parent.moduleSpecifier;
    if (!ts.isStringLiteral(module) || module.text !== "@mohassan/contracts") return undefined;
    return (imported.propertyName ?? imported.name).text;
  }

  function responseContract(node: ts.CallExpression | ts.NewExpression, name: string): string | undefined {
    const schemaPosition = { shareJson: 0, skillRequest: 1, useSkillResource: 1, boundedRequest: 1, skillPost: 2 };
    const schema = node.arguments?.[schemaPosition[name as keyof typeof schemaPosition]];
    const direct = importContract(schema) ?? importContract(node.typeArguments?.[0]);
    if (direct) return direct;
    const outer = ts.isAwaitExpression(node.parent) ? node.parent.parent : node.parent;
    if (ts.isCallExpression(outer) && ts.isPropertyAccessExpression(outer.expression)
        && ["parse", "safeParse"].includes(outer.expression.name.text)) return importContract(outer.expression.expression);
    return undefined;
  }

  function pathFromProducer(producer: string, pattern: RegExp) {
    const template = pattern.exec(readFileSync(join(root, producer), "utf8"))?.[1];
    if (!template) throw new Error(`Cannot resolve API URL returned by ${producer}`);
    return template.replace(/\$\{([^}]+)\}/g, (_match, value: string) => /^\w+$/.test(value) ? `:${value}` : ":token");
  }

  function record(source: ts.SourceFile, node: ts.Node, method: string, path: string, transport?: ClientCall["transport"], note?: string) {
    const file = relative(root, source.fileName).split(sep).join("/");
    const line = source.getLineAndCharacterOfPosition(node.getStart()).line + 1;
    const routePath = path.split(/[?#]/)[0]!;
    calls.push({
      client: "Web", method, path: routePath, file, line, transport,
      note: note ?? routeNotes[`${method} ${routePath}`],
      auth: transport ? "anonymous" : undefined,
      response: ts.isCallExpression(node) || ts.isNewExpression(node) ? responseContract(node, node.expression.getText()) : undefined,
      memberVisible: memberComponents.has(basename(file)) || path === "/api/access",
    });
  }

  for (const file of files) {
    const source = program.getSourceFile(join(root, file))!;
    const templates = new Map<string, string>();
    // Find path expressions in wrappers that add a fixed prefix. Remove only the parameter they receive from callers.
    function collectTemplates(node: ts.Node) {
      if (ts.isCallExpression(node) && ["api", "fetch"].includes(node.expression.getText()) && node.arguments[0]) {
        const wrapper = owningFunction(node);
        const paths = strings(node.arguments[0]);
        if (wrapper && Object.values(localSignatures).some(signature => signature.pathWrapper === wrapper)) {
          const prefix = paths.find(path => path.startsWith("/api/") && path.endsWith(dynamic));
          if (prefix) templates.set(wrapper, prefix.slice(0, -dynamic.length));
        }
        if (basename(file) === "google-ads-workspace.tsx" && wrapper === "step") {
          const draft = paths.find(path => path.endsWith(dynamic));
          if (draft) templates.set(wrapper, draft.slice(0, -dynamic.length));
        }
      }
      ts.forEachChild(node, collectTemplates);
    }
    if (Object.keys(localSignatures).some(key => key.startsWith(`${basename(file)}:`))) collectTemplates(source);

    function visit(node: ts.Node) {
      if (ts.isCallExpression(node) || ts.isNewExpression(node)) {
        const name = node.expression.getText();
        const args = node.arguments ?? [];
        const signature = localSignatures[`${basename(file)}:${name}`] ?? signatures[name];
        const enclosing = owningFunction(node);
        const relay = file === "apps/web/app/api/[...path]/route.ts";
        const wrapperFetch = name === "fetch" && enclosing && fetchWrappers.has(enclosing) && args[0] && forwardsPath(args[0]);
        const forwarded = (name === "api" && enclosing === "post" && basename(file) === "assistant-app.tsx")
          || (name === "api" && enclosing === "step" && basename(file) === "google-ads-workspace.tsx");
        if (signature && args.length && !relay && !wrapperFetch && !forwarded) {
          const pathPart = args[signature.path ?? 0];
          const options = args[signature.options ?? -1];
          const explicit = args[signature.methodArg ?? -1] ?? property(options, "method");
          const body = args[signature.body ?? -1] ?? (signature.optionsBody ? property(options, "body") : undefined);
          const method = signature.method ?? (body && body.getText() !== "undefined" ? "POST" : "GET");
          const paths = strings(pathPart);
          for (const pathPartValue of paths) {
            if (pathPartValue.startsWith(dynamic)) continue;
            const prefix = signature.pathWrapper ? templates.get(signature.pathWrapper) : "";
            if (prefix === undefined) throw new Error(`Cannot resolve ${name} API prefix in ${file}`);
            const path = prefix + pathPartValue;
            if (path.startsWith("/api/")) {
              for (const value of explicit ? strings(explicit) : [method]) {
                if (/^[A-Z]+$/.test(value)) record(source, node, value, path);
              }
            }
          }
        }

        // Google Ads buttons pass a string action through a React prop before appending it to a draft URL.
        if (file === "apps/web/components/google-ads-workspace.tsx" && name === "onStep") {
          const [action] = strings(args[0]);
          const api = templates.get("api");
          const step = templates.get("step");
          if (!api || !step || !action || action === dynamic) throw new Error(`Cannot resolve Google Ads draft workflow in ${file}`);
          record(source, node, "POST", api + step + action);
        }
        if (name === "location.assign" && ((basename(file) === "google-ads-workspace.tsx" && enclosing === "connect")
            || (basename(file) === "assistant-app.tsx" && args[0]?.getText() === "authorizationUrl"))) {
          record(source, node, "GET", pathFromProducer("packages/google-ads/src/control.ts", /const redirectUri = `\$\{config.webOrigin\}([^`]+)`/),
            undefined, "Browser return from Google Ads OAuth.");
        }

        // The mutation callback passes a descriptor object to skillPost.
        if (file === "apps/web/components/skill-experiments.tsx" && name === "mutate" && args[1] && ts.isArrowFunction(args[1]) && ts.isBlock(args[1].body)) {
          for (const statement of args[1].body.statements) {
            if (!ts.isReturnStatement(statement)) continue;
            for (const path of strings(property(statement.expression, "path"))) {
              if (path.startsWith("/api/")) record(source, statement, "POST", path);
            }
          }
        }
      }
      if (ts.isJsxAttribute(node) && node.initializer && ts.isJsxExpression(node.initializer)) {
        const expression = node.initializer.expression;
        const attribute = node.name.getText();
        if (["href", "src"].includes(attribute)) {
          for (const path of strings(expression)) if (path.startsWith("/api/")) record(source, node, "GET", path);
        }
        const producer = responseLinks.find(link => link.file === file && expression?.getText().startsWith(link.expression)
          && ("attribute" in link ? attribute === link.attribute : ["href", "src"].includes(attribute)));
        if (producer) {
          const path = pathFromProducer(producer.producer, producer.pattern) + ("suffix" in producer ? producer.suffix : "");
          const note = path.startsWith("/p/") ? "Local Studio preview requires the server-issued URL and its active preview capability (apps/server/src/studio-live.ts:96)." : undefined;
          record(source, node, "GET", path, "transport" in producer ? producer.transport : undefined, note);
        }
      }
      ts.forEachChild(node, visit);
    }
    visit(source);
  }
  return calls;
}
