import { afterEach, describe, expect, it, vi } from "vitest";
import { createPr, defaultBranch, findOpenPr, parseRemote, parseSlug } from "../src/github.js";

afterEach(() => vi.unstubAllGlobals());

const json = (body: unknown, status = 200) => Promise.resolve(new Response(JSON.stringify(body), { status }));

describe("parseRemote", () => {
  it("reads ssh and https GitHub remotes", () => {
    expect(parseRemote("git@github.com:darnit-sh/darnit.git")).toEqual({ owner: "darnit-sh", repo: "darnit" });
    expect(parseRemote("https://github.com/darnit-sh/darnit")).toEqual({ owner: "darnit-sh", repo: "darnit" });
    expect(parseRemote("https://github.com/darnit-sh/darnit.git/")).toEqual({ owner: "darnit-sh", repo: "darnit" });
    expect(parseRemote("git@gitlab.com:x/y.git")).toBeUndefined();
    expect(parseSlug("o/r")).toEqual({ owner: "o", repo: "r" });
    expect(parseSlug("nope")).toBeUndefined();
  });
});

describe("GitHub API calls", () => {
  it("reads the default branch, finds an open pull request, and creates one", async () => {
    const calls: { url: string; init?: RequestInit | undefined }[] = [];
    vi.stubGlobal("fetch", (url: string, init?: RequestInit): Promise<Response> => {
      calls.push({ url, init });
      if (url.endsWith("/repos/o/r")) return json({ default_branch: "trunk" });
      if (url.includes("/pulls?")) return json([{ html_url: "https://github.com/o/r/pull/7" }]);
      return json({ html_url: "https://github.com/o/r/pull/8" }, 201);
    });
    const repo = { owner: "o", repo: "r" };
    expect(await defaultBranch("tok", repo)).toBe("trunk");
    expect(await findOpenPr("tok", repo, "darnit/x")).toBe("https://github.com/o/r/pull/7");
    expect(await createPr("tok", repo, { title: "t", head: "darnit/x", base: "trunk", body: "b" })).toBe("https://github.com/o/r/pull/8");

    expect(calls[1]?.url).toContain(`head=${encodeURIComponent("o:darnit/x")}`);
    expect(calls[2]?.init?.method).toBe("POST");
    expect(JSON.parse(calls[2]?.init?.body as string)).toEqual({ title: "t", head: "darnit/x", base: "trunk", body: "b" });
    for (const c of calls) expect((c.init?.headers as Record<string, string>).authorization).toBe("Bearer tok");
  });

  it("reports API failures without leaking the token", async () => {
    vi.stubGlobal("fetch", () => Promise.resolve(new Response("Bad credentials", { status: 401 })));
    await expect(defaultBranch("secret-token", { owner: "o", repo: "r" })).rejects.toThrow(/401 Bad credentials/);
    await expect(defaultBranch("secret-token", { owner: "o", repo: "r" })).rejects.not.toThrow(/secret-token/);
  });
});
