import { createHash } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve, sep } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { buildInvocation, git } from "./git.ts";
import { blobBatch, blobBytes, createMirror, hasCommit, parseRemoteRepo, remoteNetworkConfig, remoteUrl, treeChildren, treeEntries, treeEntriesBySkill, validRemoteCommit, validRemoteRef } from "./git-remote.ts";

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

describe("whole-folder listing and batched blob reads (no network)", () => {
  const skillMd = "---\nname: seo\ndescription: يوجه كتابة مقال عربي متوافق مع محركات البحث.\n---\nاكتب المقال بعناية.\n";
  const arabic = "# الكلمات المفتاحية\nكلمة أولى، كلمة ثانية، وكلمة ثالثة.\n".repeat(60);
  /** A raw tree object, so a file name can hold bytes that are not UTF-8; `git()` only ever passes text. */
  async function rawTree(repo: string, entries: { mode: string; name: Buffer; id: string }[]) {
    const sorted = [...entries].sort((a, b) => Buffer.compare(a.mode === "40000" ? Buffer.concat([a.name, Buffer.from("/")]) : a.name, b.mode === "40000" ? Buffer.concat([b.name, Buffer.from("/")]) : b.name));
    const body = Buffer.concat(sorted.map((entry) => Buffer.concat([Buffer.from(`${entry.mode} `), entry.name, Buffer.from([0]), Buffer.from(entry.id, "hex")])));
    const file = join(await scratch(), "tree.bin");
    await writeFile(file, body);
    return (await git(repo, ["hash-object", "-t", "tree", "-w", "--", file])).stdout.trim();
  }
  async function fixture() {
    const repo = await scratch();
    await git(repo, ["init", "-q", "--bare"]);
    const blob = async (content: string) => (await git(repo, ["hash-object", "-w", "--stdin"], { input: content })).stdout.trim();
    const manifest = await blob(skillMd), reference = await blob(arabic), other = await blob("---\nname: other\ndescription: مهارة أخرى للاختبار فقط.\n---\nنص.\n");
    const references = await rawTree(repo, [{ mode: "100644", name: Buffer.from("الكلمات المفتاحية.md"), id: reference }]);
    const seo = await rawTree(repo, [{ mode: "100644", name: Buffer.from("SKILL.md"), id: manifest }, { mode: "40000", name: Buffer.from("مراجع"), id: references },
      { mode: "120000", name: Buffer.from("link"), id: manifest }, { mode: "160000", name: Buffer.from("vendored"), id: "a".repeat(40) }]);
    const bad = await rawTree(repo, [{ mode: "100644", name: Buffer.from("SKILL.md"), id: other }, { mode: "100644", name: Buffer.from([0x6e, 0xff, 0xfe, 0x2e, 0x6d, 0x64]), id: other }]);
    const plain = await rawTree(repo, [{ mode: "100644", name: Buffer.from("SKILL.md"), id: other }]);
    const skills = await rawTree(repo, [{ mode: "40000", name: Buffer.from("seo"), id: seo }, { mode: "40000", name: Buffer.from("bad"), id: bad }, { mode: "40000", name: Buffer.from("plain"), id: plain }, { mode: "100644", name: Buffer.from("README.md"), id: other }]);
    const root = await rawTree(repo, [{ mode: "40000", name: Buffer.from("skills"), id: skills }]);
    const commit = (await git(repo, ["commit-tree", root, "-m", "batched read fixture"], { deterministicDate: true })).stdout.trim();
    return { repo, commit, manifest, reference, other };
  }
  it("lists every skill folder in one call, relative to each folder, and fails only a folder with a non-UTF-8 name", async () => {
    const { repo, commit, manifest, reference } = await fixture();
    const listing = await treeEntriesBySkill(repo, commit, "skills");
    expect([...listing.skills.keys()].sort()).toEqual(["plain", "seo"]);
    expect([...listing.unreadable]).toEqual(["bad"]);
    const seo = Object.fromEntries(listing.skills.get("seo")!.map((entry) => [entry.path, entry]));
    expect(Object.keys(seo).sort()).toEqual(["SKILL.md", "link", "vendored", "مراجع/الكلمات المفتاحية.md"]);
    expect(seo["SKILL.md"]).toEqual({ mode: "100644", type: "blob", objectId: manifest, size: Buffer.byteLength(skillMd), path: "SKILL.md" });
    expect(seo["مراجع/الكلمات المفتاحية.md"]).toMatchObject({ objectId: reference, size: Buffer.byteLength(arabic) });
    expect(seo.link).toMatchObject({ mode: "120000", type: "blob" });
    expect(seo.vendored).toEqual({ mode: "160000", type: "commit", objectId: "a".repeat(40), size: null, path: "vendored" });
    // The per-skill listing agrees with the grouped one.
    expect((await treeEntries(repo, commit, "skills/seo")).map((entry) => entry.path.slice("skills/seo/".length)).sort()).toEqual(Object.keys(seo).sort());
  });
  it("reads many blobs byte-exact in one process and refuses any mismatch", async () => {
    const { repo, manifest, reference, other } = await fixture();
    const requests = [{ objectId: reference, size: Buffer.byteLength(arabic) }, { objectId: manifest, size: Buffer.byteLength(skillMd) }, { objectId: reference, size: Buffer.byteLength(arabic) }];
    const blobs = await blobBatch(repo, requests);
    expect([...blobs.keys()]).toEqual([reference, manifest]);
    expect(sha256(blobs.get(reference)!)).toBe(sha256(Buffer.from(arabic, "utf8")));
    expect(new TextDecoder("utf-8", { fatal: true }).decode(blobs.get(manifest)!)).toBe(skillMd);
    expect((await blobBatch(repo, [])).size).toBe(0);
    // A blob larger than announced is stopped at the announced size; a smaller one changes the header.
    await expect(blobBatch(repo, [{ objectId: other, size: 3 }])).rejects.toMatchObject({ code: "GIT_REMOTE_TOO_LARGE" });
    await expect(blobBatch(repo, [{ objectId: manifest, size: Buffer.byteLength(skillMd) + 10 }])).rejects.toMatchObject({ code: "GIT_REMOTE_UNREACHABLE" });
    await expect(blobBatch(repo, [{ objectId: "c".repeat(40), size: 3 }])).rejects.toMatchObject({ code: "GIT_REMOTE_UNREACHABLE" });
    await expect(blobBatch(repo, [{ objectId: manifest.toUpperCase(), size: 3 }])).rejects.toMatchObject({ code: "GIT_REMOTE_REJECTED" });
    await expect(blobBatch(repo, [{ objectId: manifest, size: 17 * 1_048_576 }])).rejects.toMatchObject({ code: "GIT_REMOTE_REJECTED" });
    await expect(blobBatch(repo, [{ objectId: manifest, size: 3 }, { objectId: manifest, size: 4 }])).rejects.toMatchObject({ code: "GIT_REMOTE_REJECTED" });
  });
});
