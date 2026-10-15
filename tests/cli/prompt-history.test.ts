import { mkdtemp, mkdir, rm, readdir, stat, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import { expect, it, vi } from "vitest";
import { historyEligible, openPromptHistory } from "../../src/store/prompt-history";
import { createNodeIO } from "../../src/cli/node-io";

it("persists only eligible workspace-scoped prompts and recalls without approving", async () => {
  const root = await mkdtemp(join(tmpdir(), "forge-history-"));
  const workspace = join(root,"work"); const other = join(root,"other");
  await mkdir(workspace); await mkdir(other); vi.stubEnv("FORGE_HOME",join(root,"state"));
  const fixture = () => {const input = new PassThrough(); return {input,io:createNodeIO({stdin:input,stdout:new PassThrough(),stderr:new PassThrough(),isTTY:true})};};
  const a = fixture(); const b = fixture();
  try {
    expect(await a.io.promptHistory?.("status",workspace)).toContain("off");
    await expect(stat(join(root,"state"))).rejects.toMatchObject({code:"ENOENT"});
    await a.io.promptHistory?.("on",workspace);
    const q = a.io.question("",new AbortController().signal); a.input.write("fix tests\r"); expect(await q).toBe("fix tests");
    const approval = a.io.readApproval?.("?",new AbortController().signal); a.input.write("yes\r"); expect(await approval).toBe(true);
    await a.io.dispose?.();
    const store = await openPromptHistory(join(root,"state"),workspace);
    expect(await store.load()).toEqual(["fix tests"]);
    expect(await (await openPromptHistory(join(root,"state"),other)).load()).toEqual([]);
    const files = await readdir(join(root,"state","prompt-history"));
    const json = files.find(f=>f.endsWith(".json")); if(!json) throw Error("Missing history");
    expect((await stat(join(root,"state","prompt-history",json))).mode & 0o777).toBe(0o600);
    await b.io.promptHistory?.("on",workspace);
    const recalled = b.io.question("",new AbortController().signal); b.input.write("\x1b[A\r"); expect(await recalled).toBe("fix tests");
    const fresh = b.io.readApproval?.("?",new AbortController().signal); b.input.write("\x1b[A\r"); expect(await fresh).toBe(false);
    await b.io.promptHistory?.("clear",workspace); expect(await store.load()).toEqual([]);
    expect(await b.io.promptHistory?.("status",workspace)).toContain("off");
    for(const bad of [" password=abc","token=abc","/approval manual","yes","\x1b[2J"," ","x".repeat(16001)]) expect(historyEligible(bad)).toBe(false);
  } finally {await a.io.dispose?.();await b.io.dispose?.();vi.unstubAllEnvs();await rm(root,{recursive:true,force:true});}
});
it("switches history scope without retaining another workspace's entries", async () => {
  const root = await mkdtemp(join(tmpdir(), "forge-history-scope-"));
  const a = join(root, "a"); const b = join(root, "b");
  await mkdir(a); await mkdir(b); vi.stubEnv("FORGE_HOME", join(root, "state"));
  const input = new PassThrough();
  const io = createNodeIO({stdin: input, stdout: new PassThrough(), stderr: new PassThrough(), isTTY: true});
  try {
    await io.promptHistory?.("on", a);
    const first = io.question("", new AbortController().signal); input.write("only workspace A\r"); await first;
    await io.promptHistory?.("scope", b);
    const next = io.question("", new AbortController().signal); input.write("\x1b[A\r"); expect(await next).toBe("");
    await io.promptHistory?.("off", b);
    const unrecorded = io.question("", new AbortController().signal); input.write("do not persist\r"); await unrecorded;
    await io.dispose?.();
    expect(await (await openPromptHistory(join(root,"state"), a)).load()).toEqual(["only workspace A"]);
    expect(await (await openPromptHistory(join(root,"state"), b)).load()).toEqual([]);
    expect(await io.promptHistory?.("on", b)).toContain("closed");
  } finally {await io.dispose?.();vi.unstubAllEnvs();await rm(root,{recursive:true,force:true});}
});

it("refuses a symlink history root", async () => {
  const root = await mkdtemp(join(tmpdir(),"forge-history-link-"));
  try {await mkdir(join(root,"state"),{mode:0o700});await mkdir(join(root,"outside"));await symlink(join(root,"outside"),join(root,"state","prompt-history"));await expect(openPromptHistory(join(root,"state"),root)).rejects.toThrow();}
  finally {await rm(root,{recursive:true,force:true});}
});
