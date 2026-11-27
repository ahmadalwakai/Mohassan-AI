import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { webCalls } from "../scripts/client-api/web.js";

describe("web API call discovery", () => {
  it("reads changed URLs, methods, imports and finite path alternatives from source", () => {
    const root = mkdtempSync(join(tmpdir(), "mohassan-web-api-"));
    try {
      const folders = ["app", "components", "lib", "public"];
      for (const folder of folders) mkdirSync(join(root, "apps/web", folder), { recursive: true });
      const source = "apps/web/components/assistant-app.tsx";
      const config = "apps/web/components/paths.ts";
      const commands = ["pause", "resume"];
      const firstPath = "/api/fixture";
      const movedPath = "/api/fixture-v2";
      function writeClient(path: string, method: string) {
        writeFileSync(join(root, config), `export const route = ${JSON.stringify(path)};`);
        writeFileSync(join(root, source), [
          'import { route } from "./paths";',
          'declare const first: boolean;',
          'declare const id: string;',
          'function request(path: string, options?: RequestInit) { return fetch(path, options); }',
          `request(route, { method: ${JSON.stringify(method)} });`,
          `request(\`\${route}/\${id}/\${first ? "${commands[0]}" : "${commands[1]}"}\`, { method: "POST" });`,
          'const image = <img src={`${route}/image/${id}`} />;',
        ].join("\n"));
      }

      function expectedCalls(path: string, method: string) {
        return [
          { method, path, line: 5 },
          ...commands.map(command => ({ method: "POST", path: `${path}/:param/${command}`, line: 6 })),
          { method: "GET", path: `${path}/image/:param`, line: 7 },
        ];
      }

      writeClient(firstPath, "GET");
      expect(webCalls(root)).toMatchObject(expectedCalls(firstPath, "GET"));
      writeClient(movedPath, "DELETE");
      expect(webCalls(root)).toMatchObject(expectedCalls(movedPath, "DELETE"));
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
