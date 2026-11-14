/**
 * COLLABORATION (Phase 3 — friend side writes): doosre owner ke repo pe branch-safe write.
 *
 * Rules:
 *  - Doosre ke repo ki DEFAULT branch pe kabhi direct write nahi. Hamesha alag branch.
 *  - Branch na bataya ho to per-user working branch: `easydevops-<login>` (nahi hai to default HEAD se banti hai).
 *  - Push access zaroori; asli faisla GitHub ka (403/404 Hinglish me).
 *  - Apne repo pe CREATE_BRANCH / LIST_BRANCHES bhi chalte hain; CREATE/EDIT/DELETE_FILE ka apna
 *    purana behaviour (executor.ts) apne repo pe waisa hi rehta hai.
 */
import { gd, req } from "@/lib/commands/pyutil";
import { ghApi, ghMsg, type RepoAccess } from "@/lib/providers/github";
import { safeRepoPath, UnsafePathError } from "@/lib/security";

type Result = Record<string, any>;

/** Ye commands doosre ke repo pe tabhi chalte hain jab branch-safe path se guzrein. */
export const FOREIGN_WRITE_COMMANDS = new Set([
  "CREATE_FILE",
  "EDIT_FILE",
  "DELETE_FILE",
  "CREATE_BRANCH",
  "CREATE_PR",
  "CODE_GENERATE",
]);

/** Naye read/branch commands (apne aur doosre dono ke repo pe). */
export const BRANCH_COMMANDS = new Set(["CREATE_BRANCH", "LIST_BRANCHES"]);

/** Foreign repo me file write karne wale commands jo executeForeignWrite sambhalta hai. */
export const FOREIGN_FILE_COMMANDS = new Set(["CREATE_FILE", "EDIT_FILE", "DELETE_FILE"]);

const BRANCH_RE = /^[A-Za-z0-9][A-Za-z0-9._\/-]{0,99}$/;

export function workingBranchName(login: string): string {
  return `easydevops-${String(login).toLowerCase().replace(/[^a-z0-9-]/g, "-")}`;
}

/** Branch naam validate (git ref rules ka safe subset). null = theek, warna error text. */
export function badBranchName(b: string): string | null {
  if (!BRANCH_RE.test(b) || b.includes("..") || b.includes("//") || b.endsWith("/") || b.endsWith(".") || b.endsWith(".lock") || b.includes("@{")) {
    return `❌ Branch naam \`${b}\` valid nahi hai. Sirf letters, numbers, \`-\`, \`_\`, \`.\`, \`/\` use karo.`;
  }
  return null;
}

const enc = (b: string) => b.split("/").map(encodeURIComponent).join("/");

/** Branch ka head SHA; [sha, null] / [null, status]. */
async function branchSha(owner: string, repo: string, branch: string, ghToken: string): Promise<[string | null, number]> {
  const r = await ghApi("GET", `/repos/${owner}/${repo}/git/ref/heads/${enc(branch)}`, ghToken);
  if (r.status_code === 200) return [r.json()?.object?.sha ?? null, 200];
  return [null, r.status_code];
}

/**
 * Branch ensure: hai to ok, nahi hai to `base` (default: repo ki default branch) ke HEAD se banao.
 * Returns [created, errorResult|null].
 */
async function ensureBranch(
  owner: string,
  repo: string,
  branch: string,
  base: string,
  ghToken: string
): Promise<[boolean, Result | null]> {
  const [have, st] = await branchSha(owner, repo, branch, ghToken);
  if (have) return [false, null];
  if (st !== 404) return [false, { reply: `❌ Branch \`${branch}\` check fail hua (${st}).`, action: "error" }];
  const [baseSha, bst] = await branchSha(owner, repo, base, ghToken);
  if (!baseSha) {
    return [false, { reply: bst === 404 ? `❌ Base branch \`${base}\` nahi mili.` : `❌ Base branch \`${base}\` check fail hua (${bst}).`, action: "error" }];
  }
  const c = await ghApi("POST", `/repos/${owner}/${repo}/git/refs`, ghToken, {
    json: { ref: `refs/heads/${branch}`, sha: baseSha },
  });
  if (c.status_code === 201) return [true, null];
  if (c.status_code === 403) return [false, { reply: `🔒 GitHub ne branch banane nahi di (403): ${ghMsg(c)}`, action: "error" }];
  if (c.status_code === 422 && /already exists/i.test(ghMsg(c))) return [false, null];
  return [false, { reply: `❌ Branch \`${branch}\` nahi bani (${c.status_code}): ${ghMsg(c)}`, action: "error" }];
}

async function fileShaOnBranch(owner: string, repo: string, path: string, branch: string, ghToken: string): Promise<string | null> {
  const r = await ghApi("GET", `/repos/${owner}/${repo}/contents/${path}?ref=${encodeURIComponent(branch)}`, ghToken);
  if (r.status_code === 200) {
    const d = r.json();
    return Array.isArray(d) ? null : (d?.sha ?? null);
  }
  return null;
}

/**
 * Write target branch tay karo: p.branch ho to wahi, warna working branch.
 * Default branch pe write hamesha block.
 */
function resolveWriteBranch(p: Record<string, any>, selfLogin: string, acc: RepoAccess): [string | null, Result | null] {
  const raw = p.branch === undefined || p.branch === null ? "" : String(p.branch).trim();
  const branch = raw || workingBranchName(selfLogin);
  const bad = badBranchName(branch);
  if (bad) return [null, { reply: bad, action: "error" }];
  if (acc.defaultBranch && branch === acc.defaultBranch) {
    return [
      null,
      {
        reply:
          `🔒 \`${acc.fullName}\` ki default branch (\`${branch}\`) pe seedha write allowed nahi — ` +
          `doosre ke repo me hamesha alag branch + PR se kaam hota hai. Branch naam badlo ya bina branch bataye try karo.`,
        action: "warning",
      },
    ];
  }
  return [branch, null];
}

export async function executeBranchCommand(
  cmd: string,
  p: Record<string, any>,
  owner: string,
  ghToken: string,
  acc: RepoAccess | null
): Promise<Result> {
  const repo = String(req(p, "repo")).trim();
  const full = `${owner}/${repo}`;
  if (!acc) return { reply: `❌ Repo \`${full}\` ka access check nahi ho paya.`, action: "error" };
  const defaultBranch = acc.defaultBranch || "main";

  if (cmd === "LIST_BRANCHES") {
    const r = await ghApi("GET", `/repos/${owner}/${repo}/branches?per_page=100`, ghToken);
    if (r.status_code !== 200) return { reply: `❌ Branches fetch nahi hui (${r.status_code}): ${ghMsg(r)}`, action: "error" };
    const list: any[] = Array.isArray(r.json()) ? r.json() : [];
    const branches = list.map((b) => ({ name: b.name, protected: !!b.protected, is_default: b.name === defaultBranch }));
    const lines = branches.map(
      (b) => `🌿 \`${b.name}\`${b.is_default ? " — default" : ""}${b.protected ? " — 🔒 protected" : ""}`
    );
    return {
      reply: `🌿 **${full}** — ${branches.length} branch${branches.length !== 1 ? "es" : ""}\n\n` + lines.join("\n") +
        (branches.length >= 100 ? "\n\n(Sirf pehli 100 dikhayi gayi.)" : ""),
      action: "list_branches",
      repo: full,
      branches,
    };
  }

  // CREATE_BRANCH
  if (!acc.push) {
    return { reply: `🔒 Branch banane ke liye kam se kam **push** access chahiye. \`${full}\` pe tumhari permission: **${acc.role}**.`, action: "warning" };
  }
  const branch = String(req(p, "branch")).trim();
  const bad = badBranchName(branch);
  if (bad) return { reply: bad, action: "error" };
  const base = String(gd(p, "base", "") || "").trim() || defaultBranch;
  const baseBad = badBranchName(base);
  if (baseBad) return { reply: baseBad, action: "error" };
  if (branch === base) return { reply: `❌ Naya branch aur base same hai (\`${branch}\`).`, action: "error" };

  const [have] = await branchSha(owner, repo, branch, ghToken);
  if (have) {
    return { reply: `ℹ️ Branch \`${branch}\` \`${full}\` me pehle se hai.`, action: "warning", repo: full, branch };
  }
  const [created, err] = await ensureBranch(owner, repo, branch, base, ghToken);
  if (err) return err;
  if (!created) return { reply: `ℹ️ Branch \`${branch}\` pehle se hai.`, action: "warning", repo: full, branch };
  return {
    reply:
      `🌿 Branch **${branch}** ban gayi \`${full}\` me (\`${base}\` se).\n` +
      `Ab file edit/AI se changes karo, phir: \`open pr from ${branch} in ${full}\``,
    action: "branch_created",
    repo: full,
    branch,
    base,
  };
}

/**
 * Doosre owner ke repo pe CREATE_FILE / EDIT_FILE / DELETE_FILE — hamesha non-default branch pe.
 * `acc` caller ne already ghRepoAccess se nikala hota hai.
 */
export async function executeForeignWrite(
  cmd: string,
  p: Record<string, any>,
  owner: string,
  ghToken: string,
  selfLogin: string,
  acc: RepoAccess
): Promise<Result> {
  const repo = String(req(p, "repo")).trim();
  const full = `${owner}/${repo}`;
  if (!acc.push) {
    return {
      reply: `🔒 \`${full}\` pe likhne ke liye kam se kam **push** access chahiye. Tumhari permission: **${acc.role}**.`,
      action: "warning",
    };
  }

  let path: string;
  try {
    path = safeRepoPath(req(p, "path"));
  } catch (e: any) {
    if (e instanceof UnsafePathError) return { reply: `❌ Ye path allowed nahi hai: ${e.message}`, action: "error" };
    throw e;
  }

  const [branch, bErr] = resolveWriteBranch(p, selfLogin, acc);
  if (!branch) return bErr as Result;
  const [created, eErr] = await ensureBranch(owner, repo, branch, acc.defaultBranch || "main", ghToken);
  if (eErr) return eErr;
  const branchNote = created ? `\n🌿 Nayi branch \`${branch}\` bani.` : "";
  const prHint = `\n➡️ PR ke liye: \`open pr from ${branch} in ${full}\``;

  const sha = await fileShaOnBranch(owner, repo, path, branch, ghToken);

  if (cmd === "DELETE_FILE") {
    if (!sha) return { reply: `❌ File \`${path}\` branch \`${branch}\` me nahi mili.`, action: "error" };
    const message = gd(p, "message", `Delete ${path} via Easy DevOps`);
    const r = await ghApi("DELETE", `/repos/${owner}/${repo}/contents/${path}`, ghToken, {
      json: { message, sha, branch },
    });
    if (r.status_code === 200) {
      return { reply: `🗑️ \`${path}\` \`${branch}\` branch se hata di (${full}).${branchNote}${prHint}`, action: "delete_file", repo: full, branch };
    }
    return { reply: `❌ Delete Error (${r.status_code}): ${ghMsg(r)}`, action: "error" };
  }

  const content: string = req(p, "content");
  if (cmd === "EDIT_FILE" && !sha) {
    return { reply: `❌ File \`${path}\` branch \`${branch}\` me exist nahi karti (${full}).`, action: "error" };
  }
  const message = gd(p, "message", `${cmd === "EDIT_FILE" ? "Update" : "Add"} ${path} via Easy DevOps`);
  const payload: Record<string, any> = {
    message,
    content: Buffer.from(content, "utf-8").toString("base64"),
    branch,
  };
  if (sha) payload.sha = sha;
  const r = await ghApi("PUT", `/repos/${owner}/${repo}/contents/${path}`, ghToken, { json: payload });
  if (r.status_code === 200 || r.status_code === 201) {
    const url = r.json()?.content?.html_url ?? "";
    const updated = !!sha;
    return {
      reply: `✅ File ${updated ? "update" : "bana"} di — \`${full}\` ki \`${branch}\` branch pe\n**${path}**\n🔗 ${url}${branchNote}${prHint}`,
      action: updated ? "update_file" : "create_file",
      url,
      repo: full,
      branch,
    };
  }
  if (r.status_code === 403 || r.status_code === 404) {
    return { reply: `🔒 GitHub ne write allow nahi kiya (${r.status_code}): ${ghMsg(r)}`, action: "error" };
  }
  return { reply: `❌ GitHub Error (${r.status_code}): ${ghMsg(r)}`, action: "error" };
}
