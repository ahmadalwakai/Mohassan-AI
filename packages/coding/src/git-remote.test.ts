import { createHash } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve, sep } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { buildInvocation, git } from "./git.ts";
import { blobBytes, createMirror, hasCommit, parseRemoteRepo, remoteNetworkConfig, remoteUrl, treeChildren, treeEntries, validRemoteCommit, validRemoteRef } from "./git-remote.ts";

const sha256 = (value: Uint8Array | string) => createHash("sha256").update(value).digest("hex");
const base = { executable: "/opt/git/bin/git", config: "/tmp/trusted/empty-config", hooks: "/tmp/trusted/empty-hooks" };
const directories: string[] = [];
async function scratch() {
  const directory = await mkdtemp(join(tmpdir(), "mohassan-git-remote-unit-")); directories.push(directory); return directory;
}
afterAll(async () => {
  for (const directory of directories.splice(0)) {
    const target = resolve(directory); const root = resolve(tmpdir());
    if (!target.startsWith(root + sep) || !target.includes("mohassan-git-remote-unit-")) throw new Error("Unsafe test cleanup target");
    await rm(target, { recursive: true, force: true });
  }
});

describe("the fixed Git invocation", () => {
  it("is unchanged for git(): the same arguments and environment as before the refactor", () => {
    const { args, env } = buildInvocation(["status", "--porcelain"], base);
    expect(args).toEqual(["--no-pager", "-c", "core.hooksPath=/tmp/trusted/empty-hooks", "-c", "core.fsmonitor=false", "-c", "core.untrackedCache=false",
      "-c", "core.attributesFile=/tmp/trusted/empty-config", "-c", "diff.external=", "-c", "commit.gpgsign=false", "-c", "tag.gpgsign=false",
      "-c", "protocol.allow=never", "-c", "protocol.file.allow=never", "-c", "core.autocrlf=false",
      "-c", "user.name=Mohassan AI", "-c", "user.email=local-demo@mohassan.invalid", "status", "--porcelain"]);
    expect(Object.keys(env).sort()).toEqual(["GIT_ATTR_NOSYSTEM", "GIT_CONFIG_GLOBAL", "GIT_CONFIG_NOSYSTEM", "GIT_CONFIG_SYSTEM", "GIT_NO_REPLACE_OBJECTS", "GIT_OPTIONAL_LOCKS", "GIT_TERMINAL_PROMPT", "LANG", "LC_ALL", "PATH", "SystemRoot", "TEMP", "TMP", "WINDIR"]);
    expect(env).toMatchObject({ PATH: dirname(base.executable), LANG: "C", LC_ALL: "C", GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_SYSTEM: base.config, GIT_CONFIG_GLOBAL: base.config, GIT_ATTR_NOSYSTEM: "1", GIT_NO_REPLACE_OBJECTS: "1", GIT_TERMINAL_PROMPT: "0", GIT_OPTIONAL_LOCKS: "0" });
    expect(buildInvocation(["log"], { ...base, deterministicDate: true }).env).toMatchObject({ GIT_AUTHOR_DATE: "2026-01-01T00:00:00Z", GIT_COMMITTER_DATE: "2026-01-01T00:00:00Z" });
    expect(args.join(" ")).not.toContain("protocol.https.allow");
  });
  it("opens HTTPS only for network calls, keeps protocol.allow=never and uses schannel only on Windows", () => {
    const { args } = buildInvocation(["ls-remote"], { ...base, extraConfig: remoteNetworkConfig("win32") });
    expect(args).toContain("protocol.allow=never"); expect(args).toContain("protocol.https.allow=always"); expect(args).toContain("http.sslBackend=schannel");
    expect(args.indexOf("protocol.allow=never")).toBeLessThan(args.indexOf("protocol.https.allow=always"));
    expect(args.at(-1)).toBe("ls-remote");
    expect(remoteNetworkConfig("linux")).toEqual(["protocol.https.allow=always", "http.followRedirects=false", "credential.helper=", "transfer.fsckObjects=true", "fetch.fsckObjects=true", "core.symlinks=false", "http.lowSpeedLimit=1000", "http.lowSpeedTime=20"]);
    expect(remoteNetworkConfig("darwin").join(" ")).not.toContain("sslBackend");
    expect(remoteNetworkConfig("win32").join(" ")).not.toContain("sslVerify");
  });
});

describe("validated remote parts", () => {
  it("builds the one GitHub URL from owner and name", () => {
    expect(parseRemoteRepo("ahmadalwakai/mohassan-skills")).toEqual({ owner: "ahmadalwakai", name: "mohassan-skills" });
    expect(remoteUrl(parseRemoteRepo("ahmadalwakai/mohassan-skills"))).toBe("https://github.com/ahmadalwakai/mohassan-skills.git");
    expect(validRemoteRef("main")).toBe("main"); expect(validRemoteRef("release/2026.11")).toBe("release/2026.11");
    expect(validRemoteCommit("a".repeat(40))).toBe("a".repeat(40));
  });
  it.each(["owner/repo.git", "owner/REPO.GIT", "../x", "a/b/c", "-owner/repo", "owner/..", "owner/.", "owner/", "/repo", "owner", "ow ner/repo"])("rejects repository %s", (value) => {
    expect(() => parseRemoteRepo(value)).toThrow(expect.objectContaining({ code: "GIT_REMOTE_REJECTED" }));
  });
  it.each(["-main", "--upload-pack=x", "feat..x", "a//b", "main/", "main.lock", "", ".hidden", "with space"])("rejects ref %s", (value) => {
    expect(() => validRemoteRef(value)).toThrow(expect.objectContaining({ code: "GIT_REMOTE_REJECTED" }));
  });
  it.each(["a".repeat(39), "A".repeat(40), "g".repeat(40), "a".repeat(41), "HEAD"])("rejects commit %s before any Git call", async (value) => {
    expect(() => validRemoteCommit(value)).toThrow(expect.objectContaining({ code: "GIT_REMOTE_REJECTED" }));
    await expect(hasCommit(await scratch(), value)).rejects.toMatchObject({ code: "GIT_REMOTE_REJECTED" });
    await expect(blobBytes(await scratch(), value, 1000)).rejects.toMatchObject({ code: "GIT_REMOTE_REJECTED" });
  });
});

describe("object reads from a local repository (no network)", () => {
  const skillMd = "---\nname: seo\ndescription: يوجه كتابة مقال عربي متوافق مع محركات البحث.\n---\nاكتب المقال بعناية.\n";
  const arabic = "# الكلمات المفتاحية\nكلمة أولى، كلمة ثانية، وكلمة ثالثة مع شرح أطول قليلاً حتى تتجاوز حدود المقاطع.\n".repeat(40);
  async function fixture() {
    const repo = await scratch();
    await git(repo, ["init", "-q"]);
    const blob = async (content: string) => (await git(repo, ["hash-object", "-w", "--stdin"], { input: content })).stdout.trim();
    const manifest = await blob(skillMd), reference = await blob(arabic);
    await git(repo, ["update-index", "--add", "--cacheinfo", `100644,${manifest},skills/seo/SKILL.md`]);
    await git(repo, ["update-index", "--add", "--cacheinfo", `100644,${reference},skills/seo/مراجع/الكلمات المفتاحية.md`]);
    await git(repo, ["update-index", "--add", "--cacheinfo", `120000,${manifest},skills/seo/link`]);
    await git(repo, ["update-index", "--add", "--cacheinfo", `160000,${"a".repeat(40)},skills/seo/vendored`]);
    await git(repo, ["update-index", "--add", "--cacheinfo", `100644,${manifest},skills/not-a-skill.md`]);
    const tree = (await git(repo, ["write-tree"])).stdout.trim();
    const commit = (await git(repo, ["commit-tree", tree, "-m", "remote read fixture"], { deterministicDate: true })).stdout.trim();
    return { repo, commit, manifest, reference };
  }
  it("round-trips Arabic names and content byte-exact and reports link and submodule modes with sizes", async () => {
    const { repo, commit, manifest, reference } = await fixture();
    expect(await hasCommit(repo, commit)).toBe(true);
    expect(await hasCommit(repo, "0".repeat(40))).toBe(false);
    const children = await treeChildren(repo, commit, "skills");
    expect(children.map((entry) => [entry.mode, entry.type, entry.path, entry.size])).toEqual([["100644", "blob", "skills/not-a-skill.md", null], ["040000", "tree", "skills/seo", null]]);
    const entries = Object.fromEntries((await treeEntries(repo, commit, "skills/seo")).map((entry) => [entry.path, entry]));
    expect(Object.keys(entries).sort()).toEqual(["skills/seo/SKILL.md", "skills/seo/link", "skills/seo/vendored", "skills/seo/مراجع/الكلمات المفتاحية.md"]);
    expect(entries["skills/seo/SKILL.md"]).toEqual({ mode: "100644", type: "blob", objectId: manifest, size: Buffer.byteLength(skillMd), path: "skills/seo/SKILL.md" });
    expect(entries["skills/seo/مراجع/الكلمات المفتاحية.md"]).toEqual({ mode: "100644", type: "blob", objectId: reference, size: Buffer.byteLength(arabic), path: "skills/seo/مراجع/الكلمات المفتاحية.md" });
    expect(entries["skills/seo/link"]).toMatchObject({ mode: "120000", type: "blob", objectId: manifest });
    expect(entries["skills/seo/vendored"]).toEqual({ mode: "160000", type: "commit", objectId: "a".repeat(40), size: null, path: "skills/seo/vendored" });
    const bytes = await blobBytes(repo, reference, 64_000);
    expect(sha256(bytes)).toBe(sha256(Buffer.from(arabic, "utf8")));
    expect(new TextDecoder("utf-8", { fatal: true }).decode(bytes)).toBe(arabic);
    expect(new TextDecoder("utf-8", { fatal: true }).decode(await blobBytes(repo, manifest, 64_000))).toBe(skillMd);
  });
  it("stops a blob read at the caller's limit and reports a missing skills folder", async () => {
    const { repo, commit, reference } = await fixture();
    await expect(blobBytes(repo, reference, 100)).rejects.toMatchObject({ code: "GIT_REMOTE_TOO_LARGE" });
    await expect(blobBytes(repo, reference, 0)).rejects.toMatchObject({ code: "GIT_REMOTE_REJECTED" });
    await expect(treeChildren(repo, commit, "missing")).rejects.toMatchObject({ code: "GIT_REMOTE_PATH_MISSING" });
    await expect(treeChildren(repo, commit, "../skills")).rejects.toMatchObject({ code: "GIT_REMOTE_REJECTED" });
    expect(await treeEntries(repo, commit, "skills/seo/مراجع")).toHaveLength(1);
    await expect(treeEntries(repo, "b".repeat(40), "skills")).rejects.toMatchObject({ code: "GIT_REMOTE_UNREACHABLE" });
  });
  it("creates a bare mirror only in an empty directory", async () => {
    const mirror = await scratch();
    await createMirror(mirror);
    expect((await git(mirror, ["rev-parse", "--is-bare-repository"])).stdout.trim()).toBe("true");
    await expect(createMirror(mirror)).rejects.toMatchObject({ code: "GIT_REMOTE_REJECTED" });
  });
});
