import { once } from "node:events";
import { type AddressInfo, createServer, type Socket } from "node:net";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createPr, defaultBranch, findOpenPr, githubToken, parseRemote, parseSlug } from "../src/github.js";

afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

const json = (body: unknown, status = 200) => Promise.resolve(new Response(JSON.stringify(body), { status }));

describe("githubToken", () => {
  it("takes GH_TOKEN when GITHUB_TOKEN is set but empty or blank, as a missing secret leaves it, and trims either", async () => {
    // No gh on PATH, so only the environment can answer.
    vi.stubEnv("PATH", "");
    for (const [github, gh] of [["", "gho_fake_for_test"], ["  \n", "gho_fake_for_test"], ["gho_fake_for_test\n", ""], ["", " gho_fake_for_test\n"]]) {
      vi.stubEnv("GITHUB_TOKEN", github);
      vi.stubEnv("GH_TOKEN", gh);
      expect(await githubToken(), JSON.stringify([github, gh])).toBe("gho_fake_for_test");
    }
  });
});

describe("parseRemote", () => {
  it("reads ssh and https GitHub remotes", () => {
    expect(parseRemote("git@github.com:darnit-sh/darnit.git")).toEqual({ owner: "darnit-sh", repo: "darnit" });
    expect(parseRemote("https://github.com/darnit-sh/darnit")).toEqual({ owner: "darnit-sh", repo: "darnit" });
    expect(parseRemote("https://github.com/darnit-sh/darnit.git/")).toEqual({ owner: "darnit-sh", repo: "darnit" });
    expect(parseRemote("git@gitlab.com:x/y.git")).toBeUndefined();
    expect(parseSlug("o/r")).toEqual({ owner: "o", repo: "r" });
    expect(parseSlug("nope")).toBeUndefined();
    expect(parseRemote("https://x-access-token:t@github.com/o/r.git")).toEqual({ owner: "o", repo: "r" });
    expect(parseRemote("ssh://git@GitHub.com/o/r.js")).toEqual({ owner: "o", repo: "r.js" });
    expect(parseRemote("git@github.com:alice_acme/r.git.git")).toEqual({ owner: "alice_acme", repo: "r.git" });
    expect(parseSlug("alice_acme/r")).toEqual({ owner: "alice_acme", repo: "r" });
  });

  it("refuses other hosts and names that would change the API path", () => {
    for (const url of [
      "https://gitlab.com/mirror/github.com/o/r.git",
      "git@gitlab.com:github.com/o/r.git",
      "https://evilgithub.com/o/r",
      "https://github.com.evil.com/o/r",
      "https://evil.com#@github.com/o/r",
      "https://evil.com?@github.com/o/r",
      "ssh://evil.com:22?@github.com/o/r",
      "evil.com:x@github.com:o/r",
      "git@github.com:../user.git",
      "https://github.com/o/r?x=1",
      "https://github.com/o/r#x",
      "https://github.com/o/..",
    ]) {
      expect(parseRemote(url), url).toBeUndefined();
    }
    for (const slug of ["../user", "o/r?x=1", "o/r#x", "o/..", "o/.", "o/r%2F..", "o.x/r"]) {
      expect(parseSlug(slug), slug).toBeUndefined();
    }
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

  it("keeps a repository name inside its path segment", async () => {
    const urls: string[] = [];
    vi.stubGlobal("fetch", (url: string) => {
      urls.push(url);
      return json({ default_branch: "main" });
    });
    await defaultBranch("tok", { owner: "o", repo: "r?x#y" });
    expect(urls).toEqual(["https://api.github.com/repos/o/r%3Fx%23y"]);
  });

  it("reports API failures without leaking the token", async () => {
    vi.stubGlobal("fetch", () => Promise.resolve(new Response("Bad credentials", { status: 401 })));
    await expect(defaultBranch("secret-token", { owner: "o", repo: "r" })).rejects.toThrow(/401 Bad credentials/);
    await expect(defaultBranch("secret-token", { owner: "o", repo: "r" })).rejects.not.toThrow(/secret-token/);
  });

  // Sends `reply` once the request arrives, then goes quiet with the connection open.
  async function stall(reply: string) {
    const server = createServer((socket) => socket.once("data", () => socket.write(reply))).listen(0, "127.0.0.1");
    await once(server, "listening");
    const connected = once(server, "connection") as Promise<[Socket]>;
    const local = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    const send = fetch;
    vi.stubGlobal("fetch", (url: string, init?: RequestInit) => send(url.replace("https://api.github.com", local), init));
    // The real limit, shortened so the test does not wait it out.
    const timeout = AbortSignal.timeout.bind(AbortSignal);
    const limit = vi.spyOn(AbortSignal, "timeout").mockImplementation(() => timeout(50));
    try {
      await expect(defaultBranch("tok", { owner: "o", repo: "r" })).rejects.toThrow("GitHub GET /repos/o/r timed out after 30 seconds");
      expect(limit).toHaveBeenCalledWith(30_000);
      const [socket] = await connected;
      socket.resume();
      if (!socket.closed) await once(socket, "close");
    } finally {
      server.close();
    }
  }

  it("gives up on a call GitHub never answers, and closes the connection", { timeout: 10_000 }, () => stall(""));

  it("gives up on a response whose body stops arriving, and closes the connection", { timeout: 10_000 }, () =>
    stall('HTTP/1.1 200 OK\r\ncontent-type: application/json\r\ntransfer-encoding: chunked\r\n\r\n1\r\n{\r\n'));

  it("names the call when the connection never comes up", async () => {
    const server = createServer().listen(0, "127.0.0.1");
    await once(server, "listening");
    const { port } = server.address() as AddressInfo;
    await new Promise((done) => server.close(done));
    const send = fetch;
    vi.stubGlobal("fetch", (url: string, init?: RequestInit) => send(url.replace("https://api.github.com", `http://127.0.0.1:${port}`), init));
    await expect(defaultBranch("tok", { owner: "o", repo: "r" })).rejects.toThrow(/^GitHub GET \/repos\/o\/r failed: fetch failed \(.*ECONNREFUSED/);
  });
});
