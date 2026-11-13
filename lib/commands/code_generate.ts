/**
 * CODE_GENERATE — multi-file agentic build/edit (code_generate.py ka faithful port).
 *
 * Default: NAYI branch pe ONE commit (Git Data API: blobs -> tree -> commit -> ref) + PR.
 * DIRECT_COMMIT_RE wale phrases se seedha default branch pe commit.
 */
import { config, OPENROUTER_MODEL } from "@/lib/config";
import { post, type PyResponse } from "@/lib/http";
import { pyRegex, CODEGEN_INSPECT_VERBS_RE, CODEGEN_STRONG_CHANGE_VERBS_RE, CODEGEN_GENERIC_DO_RE } from "@/lib/commands/intent_parser";
import { pyStr } from "@/lib/pyjson";
import { ghApi } from "@/lib/providers/github";
import { safeRepoPath, UnsafePathError } from "@/lib/security";
import { AIError } from "@/lib/commands/errors";
import { K, gd, req, pyTruthy } from "@/lib/commands/pyutil";

export const MAX_CODEGEN_FILES = 20;
const CODEGEN_CONTEXT_CAP = 18000; // chars of existing-file content sent to the model

// Phrases jo default branch+PR flow se opt-out karte hain (case-insensitive)
const DIRECT_COMMIT_RE = pyRegex(
  String.raw`\b(?:directly?|direct\s+main|seedhe|seedha)\b.{0,20}\b(?:commit|push|karo|kar\s*do)\b` +
    String.raw`|\bmain\s+mein\s+(?:directly?|seedhe|seedha)\b` +
    String.raw`|\bno\s+pr\b|\bwithout\s+(?:a\s+)?pr\b|\bskip\s+(?:the\s+)?pr\b`,
  "i"
);

const b64decode = (s: string) => Buffer.from(String(s), "base64").toString("utf-8");
const sliceStr = (s: string, n: number) => s.slice(0, n);

function slugifyForBranch(text: string, maxLen = 30): string {
  const slug = text.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
  return slug.slice(0, maxLen).replace(/^-+|-+$/g, "") || "update";
}

export function generateBranchName(instruction: string): string {
  return `codegen/${slugifyForBranch(instruction)}-${Math.floor(Date.now() / 1000) % 100000}`;
}

const CODEGEN_MULTIFILE_SYSTEM_PROMPT = (maxFiles: number) => `You are an agentic coding assistant working inside a GitHub repo via a chat interface. The user works from their phone, in Hinglish (Hindi+English mix) or English — understand both.

Respond with ONLY a single JSON object, nothing else — no markdown fences, no preamble, no text outside the JSON.

JSON shape:
{
  "reply": "short chat message to show the user (can be Hinglish)",
  "reasoning": "1-3 short sentences explaining what you're about to do and why. Omit or leave empty if there are no file changes.",
  "files": [
    {
      "path": "relative/file/path.ext",
      "action": "create" | "edit",
      "content": "FULL file content — only for action=create, or for action=edit when the file is short (under ~40 lines)",
      "edits": [ { "find": "exact snippet from the current file content shown to you", "replace": "new snippet" } ]
    }
  ]
}

RULES:
1. action="create": always give full "content", omit "edits".
2. action="edit" on a file whose current content was shown to you: prefer "edits" — an array of {find, replace} where find is an exact, short, unique substring of the current content. Only fall back to full "content" for edits when the file is short (under ~40 lines) or the change touches most of the file.
3. If the user is asking to UNDERSTAND, EXPLAIN, REVIEW, or DESCRIBE existing code — not asking for anything to be built, changed, added, or fixed — respond with ONLY: {"reply": "your explanation here", "files": []}. Being shown file content does not mean you should regenerate it. Only include a non-empty "files" array when the message itself asks for a change.
4. Never invent file content you weren't asked for. Never touch files unrelated to the request.
5. MULTI-FILE PROJECTS MUST WORK TOGETHER: if you create/edit an HTML+CSS+JS trio, the HTML must correctly <link>/<script src> the exact filenames you used. Every id/class the JS queries must exist in the HTML. Every class the CSS styles must exist in the HTML.
6. Keep "reply" short (1-3 sentences). "reasoning" is shown before files are applied.
7. Maximum ${maxFiles} files per response.`;

/** Instruction se relevant files ka content (CODEGEN_CONTEXT_CAP tak). mentioned files pehle. */
export async function buildCodegenFileContext(
  repo: string,
  owner: string,
  ghToken: string,
  instruction: string,
  existingPaths: string[]
): Promise<string> {
  if (!existingPaths.length) return "";
  const lowered = instruction.toLowerCase();
  const mentioned = existingPaths.filter((p) => {
    const pl = p.toLowerCase();
    return lowered.includes(pl) || lowered.includes(pl.split("/").pop() as string);
  });
  const mentionedSet = new Set(mentioned);
  const rest = existingPaths.filter((p) => !mentionedSet.has(p));
  const ordered = [...mentioned, ...rest];

  const outParts: string[] = [];
  let total = 0;
  for (const path of ordered.slice(0, 30)) {
    const r = await ghApi("GET", `/repos/${owner}/${repo}/contents/${path}`, ghToken);
    if (r.status_code !== 200) continue;
    const fileData = r.json();
    if (gd(fileData, "type", null) !== "file" || gd(fileData, "size", 0) > 60000) continue;
    let content: string;
    try {
      content = b64decode(K(fileData, "content"));
    } catch {
      continue;
    }
    const block = `--- ${path} ---\n${content}\n\n`;
    if (total + block.length > CODEGEN_CONTEXT_CAP) {
      outParts.push(`--- ${path} --- (omitted for space, ${content.length} chars)\n\n`);
      continue;
    }
    outParts.push(block);
    total += block.length;
  }
  return outParts.join("").trim();
}

/** Git Trees API se poori repo ke file paths. Returns [paths|null, response]. */
export async function listRepoPaths(
  repo: string,
  owner: string,
  ghToken: string
): Promise<[string[] | null, PyResponse]> {
  const repoR = await ghApi("GET", `/repos/${owner}/${repo}`, ghToken);
  if (repoR.status_code !== 200) return [null, repoR];
  const defaultBranch = gd(repoR.json(), "default_branch", "main");
  const treeR = await ghApi("GET", `/repos/${owner}/${repo}/git/trees/${defaultBranch}?recursive=1`, ghToken);
  if (treeR.status_code !== 200) return [null, treeR];
  const paths = (gd(treeR.json(), "tree", []) as any[])
    .filter((item) => gd(item, "type", null) === "blob")
    .map((item) => K(item, "path") as string);
  return [paths, repoR];
}

export async function callOpenrouterMultifile(instruction: string, fileContext: string): Promise<any> {
  const systemPrompt = CODEGEN_MULTIFILE_SYSTEM_PROMPT(MAX_CODEGEN_FILES);
  const userContent = fileContext ? `Existing files:\n${fileContext}\n\nRequest: ${instruction}` : instruction;
  const resp = await post("https://openrouter.ai/api/v1/chat/completions", {
    headers: { Authorization: `Bearer ${pyStr(config.OPENROUTER_KEY ?? null)}`, "Content-Type": "application/json" },
    json: {
      model: OPENROUTER_MODEL,
      messages: [
        { role: "system", content: systemPrompt },
        { role: "user", content: userContent },
      ],
      temperature: 0.3,
    },
    timeout: 60,
  });
  const aiResp = resp.json();

  if (aiResp && typeof aiResp === "object" && "error" in aiResp) {
    throw new AIError(aiResp.error?.message ?? "Unknown AI error");
  }
  let raw: string = String(aiResp.choices[0].message.content).trim();
  raw = raw.replace(/^```(?:json)?\n/, "");
  raw = raw.replace(/\n```$/, "");
  let data: any;
  try {
    data = JSON.parse(raw);
  } catch {
    // Model kabhi JSON ko sentence me lapet deta hai — bahari {...} span nikaalo
    const m = /\{[\s\S]*\}/.exec(raw);
    if (!m) throw new AIError("AI ne valid JSON nahi diya");
    data = JSON.parse(m[0]);
  }
  return data;
}

function replaceFirst(content: string, find: string, replace: string): string {
  const idx = content.indexOf(find);
  return content.slice(0, idx) + replace + content.slice(idx + find.length);
}

/** Whitespace-tolerant substring search. Returns content ka exact substring ya null. */
export function findFuzzyMatch(content: string, find: string): string | null {
  if (!find) return null;

  const normalize = (s: string) =>
    s
      .replace(/[ \t]+/g, " ")
      .replace(/\s*\n\s*/g, "\n")
      .trim();

  const normFind = normalize(find);
  if (!normFind) return null;

  const lines = content.split("\n");
  const findLineCount = (find.match(/\n/g) || []).length + 1;

  // Python set {n, n+1, max(1, n-1)} ka iteration order: small ints -> (value % 8) ascending
  const sizes = Array.from(new Set([findLineCount, findLineCount + 1, Math.max(1, findLineCount - 1)])).sort(
    (a, b) => (a % 8) - (b % 8)
  );

  for (const windowSize of sizes) {
    for (let i = 0; i < lines.length - windowSize + 1; i++) {
      const candidate = lines.slice(i, i + windowSize).join("\n");
      if (normalize(candidate) === normFind) return candidate;
    }
  }
  return null;
}

/** Ek file pe edits apply. Returns [newContent, changed, missed]. */
export function applyFileEdits(existingContent: string, edits: any[] | null | undefined): [string, boolean, boolean] {
  let content = existingContent;
  let changed = false;
  let missed = false;
  for (const e of edits || []) {
    const find = gd(e, "find", null);
    const replace = gd(e, "replace", "");
    if (!find) continue;
    if (content.includes(find)) {
      content = replaceFirst(content, find, replace);
      changed = true;
      continue;
    }
    const fuzzy = findFuzzyMatch(content, find);
    if (fuzzy !== null) {
      content = replaceFirst(content, fuzzy, replace);
      changed = true;
      continue;
    }
    missed = true;
  }
  return [content, changed, missed];
}

const msgOf = (r: PyResponse, dflt: string): string => (r.content.length ? gd(r.json(), "message", dflt) : dflt);

/**
 * Shared Git Data API commit helper (blobs -> tree -> commit -> ref update).
 * branch=null => default branch pe; warna branch (nahi hai to default HEAD se banti hai).
 * Returns [ok, replyOrError, repoUrl|null, branchUsed|null]
 */
export async function commitFilesToRepo(
  owner: string,
  repo: string,
  ghToken: string,
  fileMap: Map<string, string>,
  message: string,
  branch: string | null = null
): Promise<[boolean, string, string | null, string | null]> {
  const repoR = await ghApi("GET", `/repos/${owner}/${repo}`, ghToken);
  if (repoR.status_code !== 200) {
    return [false, msgOf(repoR, "Repo nahi mila"), null, null];
  }
  const defaultBranch = gd(repoR.json(), "default_branch", "main");
  const repoUrl = gd(repoR.json(), "html_url", "");
  const targetBranch = branch || defaultBranch;

  const defaultRefR = await ghApi("GET", `/repos/${owner}/${repo}/git/ref/heads/${defaultBranch}`, ghToken);
  if (defaultRefR.status_code !== 200) {
    return [false, "Base branch ref nahi mila.", null, null];
  }
  const defaultHeadSha: string = K(K(defaultRefR.json(), "object"), "sha");

  let baseCommitSha: string;
  if (branch && branch !== defaultBranch) {
    const branchRefR = await ghApi("GET", `/repos/${owner}/${repo}/git/ref/heads/${branch}`, ghToken);
    if (branchRefR.status_code === 200) {
      baseCommitSha = K(K(branchRefR.json(), "object"), "sha");
    } else if (branchRefR.status_code === 404) {
      // Branch nahi hai — default HEAD pe point karti nayi ref banao (GitHub UI jaisa)
      const createRefR = await ghApi("POST", `/repos/${owner}/${repo}/git/refs`, ghToken, {
        json: { ref: `refs/heads/${branch}`, sha: defaultHeadSha },
      });
      if (createRefR.status_code !== 201) {
        return [false, `Branch \`${branch}\` create Error: ${msgOf(createRefR, "branch create failed")}`, null, null];
      }
      baseCommitSha = defaultHeadSha;
    } else {
      return [false, `Branch \`${branch}\` lookup Error: ${msgOf(branchRefR, "branch lookup failed")}`, null, null];
    }
  } else {
    baseCommitSha = defaultHeadSha;
  }

  const baseCommitR = await ghApi("GET", `/repos/${owner}/${repo}/git/commits/${baseCommitSha}`, ghToken);
  if (baseCommitR.status_code !== 200) {
    return [false, "Base commit nahi mila.", null, null];
  }
  const baseTreeSha: string = K(K(baseCommitR.json(), "tree"), "sha");

  const treeEntries: any[] = [];
  for (const [path, content] of fileMap) {
    const contentB64 = Buffer.from(content, "utf-8").toString("base64");
    const blobR = await ghApi("POST", `/repos/${owner}/${repo}/git/blobs`, ghToken, {
      json: { content: contentB64, encoding: "base64" },
    });
    if (blobR.status_code !== 201) {
      return [false, `\`${path}\` ke liye blob create Error: ${msgOf(blobR, "blob create failed")}`, null, null];
    }
    treeEntries.push({ path, mode: "100644", type: "blob", sha: K(blobR.json(), "sha") });
  }

  const treeR = await ghApi("POST", `/repos/${owner}/${repo}/git/trees`, ghToken, {
    json: { base_tree: baseTreeSha, tree: treeEntries },
  });
  if (treeR.status_code !== 201) {
    return [false, `Tree create Error: ${msgOf(treeR, "tree create failed")}`, null, null];
  }
  const newTreeSha = K(treeR.json(), "sha");

  const commitR = await ghApi("POST", `/repos/${owner}/${repo}/git/commits`, ghToken, {
    json: { message, tree: newTreeSha, parents: [baseCommitSha] },
  });
  if (commitR.status_code !== 201) {
    return [false, `Commit create Error: ${msgOf(commitR, "commit create failed")}`, null, null];
  }
  const newCommitSha = K(commitR.json(), "sha");

  const updateRefR = await ghApi("PATCH", `/repos/${owner}/${repo}/git/refs/heads/${targetBranch}`, ghToken, {
    json: { sha: newCommitSha },
  });
  if (updateRefR.status_code !== 200) {
    return [false, `Branch update Error: ${msgOf(updateRefR, "ref update failed")}`, null, null];
  }

  return [true, "", `${repoUrl}/tree/${targetBranch}`, targetBranch];
}

/** PR kholta hai. Returns [ok, replyOrError, prUrl|null]. */
export async function createPullRequest(
  owner: string,
  repo: string,
  ghToken: string,
  headBranch: string,
  baseBranch: string,
  title: string,
  body = ""
): Promise<[boolean, string, string | null]> {
  const r = await ghApi("POST", `/repos/${owner}/${repo}/pulls`, ghToken, {
    json: { title, head: headBranch, base: baseBranch, body },
  });
  if (r.status_code === 201) {
    const d = r.json();
    return [true, "", gd(d, "html_url", "")];
  }
  let err: string = msgOf(r, "PR create failed");
  // 422 + "No commits between" = head==base ya abhi koi diff nahi
  if (r.status_code === 422 && err.includes("No commits between")) {
    err = `\`${headBranch}\` aur \`${baseBranch}\` ke beech koi difference nahi hai — pehle branch pe kuch commit karo.`;
  }
  return [false, err, null];
}

export async function handleCodeGenerate(
  params: Record<string, any>,
  owner: string,
  ghToken: string
): Promise<Record<string, any>> {
  const repo = req(params, "repo");
  const instruction: string = req(params, "instruction");

  const [existingPaths, repoOrErr] = await listRepoPaths(repo, owner, ghToken);
  if (existingPaths === null) {
    return { reply: `❌ GitHub: ${msgOf(repoOrErr, "Repo nahi mila")}`, action: "error", source: "hybrid" };
  }

  const fileContext = await buildCodegenFileContext(repo, owner, ghToken, instruction, existingPaths);
  const aiData = await callOpenrouterMultifile(instruction, fileContext);

  const replyText = gd(aiData, "reply", null) || "…";
  const reasoning = String(gd(aiData, "reasoning", null) || "").trim();
  let files: any[] = gd(aiData, "files", null) || [];

  // Read-vs-write safety net: sirf "explain/review" jaisa sawaal ho to AI ki files drop.
  const loweredInstruction = instruction.toLowerCase();
  const askedToInspect = pyRegex(CODEGEN_INSPECT_VERBS_RE).test(loweredInstruction);
  let askedForChange = pyRegex(CODEGEN_STRONG_CHANGE_VERBS_RE).test(loweredInstruction);
  if (!askedForChange) {
    const endsWithInspect = pyRegex(CODEGEN_INSPECT_VERBS_RE + "$");
    for (const m of loweredInstruction.matchAll(pyRegex(CODEGEN_GENERIC_DO_RE, "g"))) {
      const preceding = loweredInstruction.slice(0, m.index).trimEnd();
      if (!endsWithInspect.test(preceding)) {
        askedForChange = true;
        break;
      }
    }
  }
  if (askedToInspect && !askedForChange) {
    files = [];
  }

  if (!files.length) {
    return { reply: replyText, action: "message", source: "hybrid" };
  }

  files = files.slice(0, MAX_CODEGEN_FILES);
  const existingSet = new Set(existingPaths);
  const fileMap = new Map<string, string>();
  const beforeMap = new Map<string, string>(); // path -> original content ("" for naye files)
  const skipped: string[] = [];

  for (const f of files) {
    const rawPath = String(gd(f, "path", null) || "").trim();
    if (!rawPath) continue;
    let path: string;
    try {
      path = safeRepoPath(rawPath);
    } catch (e: any) {
      if (e instanceof UnsafePathError) {
        // Unsafe AI path — sirf ye file skip, poora commit nahi
        skipped.push(`${rawPath} (unsafe path, skip ho gaya)`);
        continue;
      }
      throw e;
    }
    const action = gd(f, "action", null);
    if (action === "create" || !existingSet.has(path)) {
      fileMap.set(path, gd(f, "content", null) || "");
      beforeMap.set(path, "");
    } else if (action === "edit") {
      const edits = gd(f, "edits", null);
      if (pyTruthy(edits)) {
        const r = await ghApi("GET", `/repos/${owner}/${repo}/contents/${path}`, ghToken);
        if (r.status_code !== 200) {
          skipped.push(path);
          continue;
        }
        const current = b64decode(K(r.json(), "content"));
        const [newContent, changed, missed] = applyFileEdits(current, edits);
        if (changed) {
          fileMap.set(path, newContent);
          beforeMap.set(path, current);
        }
        if (missed && !changed) skipped.push(path);
      } else if (gd(f, "content", null) !== null) {
        // Full-content edit (chhoti file) — diff view ke liye original chahiye
        const r = await ghApi("GET", `/repos/${owner}/${repo}/contents/${path}`, ghToken);
        const current = r.status_code === 200 ? b64decode(K(r.json(), "content")) : "";
        fileMap.set(path, f.content);
        beforeMap.set(path, current);
      }
    }
  }

  if (!fileMap.size) {
    const note = skipped.length
      ? `\n\n⚠️ In files ke edits apply nahi hue (snippet match nahi hua): ${skipped.join(", ")}`
      : "";
    return { reply: replyText + note, action: "message", source: "hybrid" };
  }

  const n = fileMap.size;
  const s = n !== 1 ? "s" : "";
  const commitMsg = `${sliceStr(instruction, 60)} via Easy DevOps (${n} file${s})`;

  const wantDirect = DIRECT_COMMIT_RE.test(instruction);
  let prUrl: string | null = null;
  let prErrorNote = "";
  let branchUsed: string | null = null;
  let repoLink: string | null = null;

  if (wantDirect) {
    const [ok, errOrEmpty, link, br] = await commitFilesToRepo(owner, repo, ghToken, fileMap, commitMsg);
    repoLink = link;
    branchUsed = br;
    if (!ok) return { reply: `❌ ${errOrEmpty}`, action: "error", source: "hybrid" };
  } else {
    const branchName = generateBranchName(instruction);
    const [ok, errOrEmpty, link, br] = await commitFilesToRepo(owner, repo, ghToken, fileMap, commitMsg, branchName);
    repoLink = link;
    branchUsed = br;
    if (!ok) return { reply: `❌ ${errOrEmpty}`, action: "error", source: "hybrid" };

    const repoR = await ghApi("GET", `/repos/${owner}/${repo}`, ghToken);
    const defaultBranch = repoR.status_code === 200 ? gd(repoR.json(), "default_branch", "main") : "main";
    const prTitle = instruction ? sliceStr(instruction, 70) : `Easy DevOps: ${n} file update`;
    const prBody = reasoning
      ? `Opened automatically by Easy DevOps.\n\n${reasoning}`
      : "Opened automatically by Easy DevOps.";
    const [prOk, prErr, url] = await createPullRequest(
      owner, repo, ghToken, branchUsed as string, defaultBranch, prTitle, prBody
    );
    prUrl = url;
    if (!prOk) {
      // Commit branch pe pahunch chuka hai, sirf PR nahi khula — note ke saath batao
      prErrorNote = `\n\n⚠️ Branch commit ho gaya, lekin PR open nahi hua: ${prErr}\nManually PR khol sakte ho: ${repoLink}`;
    }
  }

  const sortedPaths = Array.from(fileMap.keys()).sort();
  const fileList = sortedPaths.map((p) => `• ${p}`).join("\n");
  const skipNote = skipped.length ? `\n\n⚠️ Skip hui (snippet match nahi hua): ${skipped.join(", ")}` : "";
  const reasoningBlock = reasoning ? `\n\n_${reasoning}_` : "";
  let linkLine: string;
  if (wantDirect) {
    linkLine = `\n\n🔗 ${repoLink}`;
  } else if (prUrl) {
    linkLine = `\n\n🌿 Branch: \`${branchUsed}\`\n🔀 PR: ${prUrl}`;
  } else {
    linkLine = `\n\n🌿 Branch: \`${branchUsed}\`${prErrorNote}`;
  }
  // `files` payload frontend ke per-file diff bubble ke liye (before/after poora content)
  return {
    reply: `✅ ${replyText}${reasoningBlock}\n\n**${n} file${s}** → \`${repo}\`\n${fileList}${skipNote}${linkLine}`,
    action: "code_generate",
    repo,
    file_count: n,
    source: "hybrid",
    files: sortedPaths.map((p) => ({ path: p, before: beforeMap.get(p) ?? "", after: fileMap.get(p) as string })),
    repo_link: repoLink,
    branch: branchUsed,
    pr_url: prUrl,
    direct_commit: wantDirect,
  };
}
