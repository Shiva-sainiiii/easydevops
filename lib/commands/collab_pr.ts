/**
 * COLLABORATION (Phase 3 — PR workflow): LIST_PRS, PR_DETAILS (compare), MERGE_PR, CLOSE_PR, COMMENT_PR.
 *
 * Sab kuch calling user ke apne GitHub token se; permission ka final faisla GitHub karta hai
 * (403/405/409/422 ko Hinglish reason me badla jaata hai). Vercel/Netlify/Render yahan kabhi nahi aate.
 */
import { gd, req } from "@/lib/commands/pyutil";
import { ghApi, ghGetCheckRuns, ghMsg, summarizeCheckRuns } from "@/lib/providers/github";

type Result = Record<string, any>;

export const PR_COMMANDS = new Set(["LIST_PRS", "PR_DETAILS", "MERGE_PR", "CLOSE_PR", "COMMENT_PR"]);

const MERGE_METHODS = ["merge", "squash", "rebase"];
const MAX_PATCH_CHARS = 6000; // per file
const MAX_TOTAL_PATCH_CHARS = 60000; // poore response me
const MAX_FILES = 100;

function prNumber(p: Record<string, any>): number | null {
  const n = Number(String(req(p, "number")).replace(/^#/, "").trim());
  return Number.isInteger(n) && n > 0 ? n : null;
}

const badNumber = (): Result => ({ reply: "❌ PR number sahi nahi hai. Jaise: `compare pr 3 in repo`.", action: "error" });

function stateLabel(pr: any): string {
  if (pr?.merged || pr?.merged_at) return "merged";
  return pr?.state === "closed" ? "closed" : "open";
}

const mapPr = (pr: any) => ({
  number: pr?.number,
  title: pr?.title ?? "",
  state: stateLabel(pr),
  draft: !!pr?.draft,
  author: pr?.user?.login ?? "",
  head: pr?.head?.ref ?? "",
  base: pr?.base?.ref ?? "",
  url: pr?.html_url ?? "",
  updated_at: pr?.updated_at ?? null,
});

/** Merge/close API errors -> saaf Hinglish reason. */
function mergeError(status: number, msg: string): string {
  const m = (msg || "").toLowerCase();
  if (status === 403) return `🔒 GitHub ne merge allow nahi kiya (403): ${msg}`;
  if (status === 404) return "❌ PR ya repo nahi mila (ya merge ka access nahi hai).";
  if (status === 405) {
    if (m.includes("protected") || m.includes("required")) return `🛡️ Branch protection rok rahi hai: ${msg}`;
    return `⛔ PR abhi mergeable nahi hai: ${msg}`;
  }
  if (status === 409) return `⚠️ Conflict ya head branch badal gayi (409): ${msg}. Branch update karke dobara try karo.`;
  if (status === 422) return `❌ Merge valid nahi (422): ${msg}`;
  return `❌ Merge fail hua (${status}): ${msg}`;
}

export async function executePrCommand(
  cmd: string,
  p: Record<string, any>,
  owner: string,
  ghToken: string
): Promise<Result> {
  const repo = String(req(p, "repo")).trim();
  const full = `${owner}/${repo}`;

  // ── LIST_PRS ──
  if (cmd === "LIST_PRS") {
    const rawState = String(gd(p, "state", "open") || "open").toLowerCase();
    const wanted = ["open", "closed", "merged", "all"].includes(rawState) ? rawState : "open";
    const apiState = wanted === "open" ? "open" : wanted === "all" ? "all" : "closed";
    const r = await ghApi("GET", `/repos/${owner}/${repo}/pulls?state=${apiState}&sort=updated&direction=desc&per_page=50`, ghToken);
    if (r.status_code !== 200) return { reply: `❌ PRs fetch nahi hue (${r.status_code}): ${ghMsg(r)}`, action: "error" };
    let prs = (Array.isArray(r.json()) ? r.json() : []).map(mapPr);
    if (wanted === "merged") prs = prs.filter((x: any) => x.state === "merged");
    // list API me merged_at hota hai, mapPr usse "merged" bana deta hai; "closed" me merged hata do
    if (wanted === "closed") prs = prs.filter((x: any) => x.state === "closed");
    if (!prs.length) {
      return { reply: `📭 \`${full}\` me koi ${wanted === "all" ? "" : wanted + " "}PR nahi hai.`, action: "pr_list", repo: full, state: wanted, prs: [] };
    }
    const icon = (s: string) => (s === "open" ? "🟢" : s === "merged" ? "🟣" : "🔴");
    const lines = prs.map((x: any) => `${icon(x.state)} #${x.number} **${x.title}** — @${x.author} — \`${x.head}\` → \`${x.base}\``);
    return {
      reply: `🔀 **${full}** — ${prs.length} ${wanted === "all" ? "" : wanted + " "}PR${prs.length !== 1 ? "s" : ""}\n\n` + lines.join("\n") +
        `\n\n💡 Compare: \`compare pr <number> in ${full}\``,
      action: "pr_list",
      repo: full,
      state: wanted,
      prs,
    };
  }

  const number = prNumber(p);
  if (number === null) return badNumber();

  // ── PR_DETAILS / COMPARE ──
  if (cmd === "PR_DETAILS") {
    const r = await ghApi("GET", `/repos/${owner}/${repo}/pulls/${number}`, ghToken);
    if (r.status_code === 404) return { reply: `❌ \`${full}\` me PR #${number} nahi mila.`, action: "error" };
    if (r.status_code !== 200) return { reply: `❌ PR fetch nahi hua (${r.status_code}): ${ghMsg(r)}`, action: "error" };
    const pr = r.json();

    const fr = await ghApi("GET", `/repos/${owner}/${repo}/pulls/${number}/files?per_page=${MAX_FILES}`, ghToken);
    const rawFiles: any[] = fr.status_code === 200 && Array.isArray(fr.json()) ? fr.json() : [];
    let budget = MAX_TOTAL_PATCH_CHARS;
    const files = rawFiles.map((f) => {
      let patch: string = typeof f.patch === "string" ? f.patch : "";
      let truncated = false;
      if (patch.length > MAX_PATCH_CHARS) {
        patch = patch.slice(0, MAX_PATCH_CHARS);
        truncated = true;
      }
      if (patch.length > budget) {
        patch = patch.slice(0, Math.max(0, budget));
        truncated = true;
      }
      budget -= patch.length;
      return {
        filename: f.filename,
        status: f.status,
        additions: f.additions ?? 0,
        deletions: f.deletions ?? 0,
        patch,
        truncated,
        binary: typeof f.patch !== "string",
      };
    });

    const headSha: string | null = pr?.head?.sha ?? null;
    let checks = null as ReturnType<typeof summarizeCheckRuns> | null;
    if (headSha) {
      const [runs, cr] = await ghGetCheckRuns(repo, headSha, owner, ghToken);
      if (cr.status_code === 200) checks = summarizeCheckRuns(runs);
    }

    const state = stateLabel(pr);
    const mergeable: boolean | null = pr?.mergeable ?? null; // null = GitHub abhi compute kar raha hai
    const mstate: string = pr?.mergeable_state ?? "unknown";
    const mergeNote =
      state !== "open" ? "" :
      mergeable === false || mstate === "dirty" ? "⚠️ Conflicts hain — merge se pehle resolve karne honge." :
      mstate === "blocked" ? "🛡️ Merge abhi blocked hai (required checks/reviews baaki)." :
      mstate === "behind" ? "ℹ️ Branch base se peeche hai." :
      mstate === "unstable" ? "⚠️ Kuch checks fail/pending hain." :
      mergeable === null ? "⏳ GitHub mergeable status compute kar raha hai — thodi der baad dobara dekho." :
      "✅ Mergeable.";

    const checkLine = checks
      ? checks.state === "none" ? "Checks: koi nahi" :
        `Checks: ${checks.state === "success" ? "✅" : checks.state === "pending" ? "⏳" : "❌"} ${checks.passed} pass · ${checks.failed} fail · ${checks.pending} pending`
      : "";
    const body = String(pr?.body ?? "").trim();
    const fileLines = files.slice(0, 30).map((f) => `• \`${f.filename}\` (+${f.additions}/-${f.deletions})`);

    const reply =
      `🔀 **PR #${number}: ${pr?.title ?? ""}** — ${state}${pr?.draft ? " (draft)" : ""}\n` +
      `${full} — @${pr?.user?.login ?? "?"} — \`${pr?.head?.ref}\` → \`${pr?.base?.ref}\`\n` +
      `${pr?.changed_files ?? files.length} files · +${pr?.additions ?? 0}/-${pr?.deletions ?? 0} · ${pr?.commits ?? "?"} commits\n` +
      (mergeNote ? `${mergeNote}\n` : "") +
      (checkLine ? `${checkLine}\n` : "") +
      (body ? `\n${body.slice(0, 500)}${body.length > 500 ? "…" : ""}\n` : "") +
      `\n**Files:**\n${fileLines.join("\n")}` +
      (files.length > 30 ? `\n…aur ${files.length - 30} files` : "") +
      `\n\n🔗 ${pr?.html_url ?? ""}`;

    return {
      reply,
      action: "pr_details",
      repo: full,
      number,
      title: pr?.title ?? "",
      state,
      draft: !!pr?.draft,
      author: pr?.user?.login ?? "",
      head: pr?.head?.ref ?? "",
      base: pr?.base?.ref ?? "",
      url: pr?.html_url ?? "",
      mergeable,
      mergeable_state: mstate,
      merge_note: mergeNote,
      additions: pr?.additions ?? 0,
      deletions: pr?.deletions ?? 0,
      commits: pr?.commits ?? null,
      changed_files: pr?.changed_files ?? files.length,
      files,
      checks_summary: checks,
      body: body.slice(0, 2000),
    };
  }

  // ── COMMENT_PR ──
  if (cmd === "COMMENT_PR") {
    const body = String(req(p, "body")).trim();
    if (!body) return { reply: "❌ Comment khaali hai.", action: "error" };
    if (body.length > 4000) return { reply: "❌ Comment bahut lamba hai (max 4000 characters).", action: "error" };
    const r = await ghApi("POST", `/repos/${owner}/${repo}/issues/${number}/comments`, ghToken, { json: { body } });
    if (r.status_code === 201) {
      return { reply: `💬 PR #${number} pe comment ho gaya.\n🔗 ${r.json()?.html_url ?? ""}`, action: "pr_comment", repo: full, number };
    }
    if (r.status_code === 404) return { reply: `❌ \`${full}\` me PR #${number} nahi mila.`, action: "error" };
    if (r.status_code === 403) return { reply: `🔒 GitHub ne comment allow nahi kiya (403): ${ghMsg(r)}`, action: "error" };
    return { reply: `❌ Comment fail hua (${r.status_code}): ${ghMsg(r)}`, action: "error" };
  }

  // MERGE_PR / CLOSE_PR — pehle PR ki halat dekho
  const cur = await ghApi("GET", `/repos/${owner}/${repo}/pulls/${number}`, ghToken);
  if (cur.status_code === 404) return { reply: `❌ \`${full}\` me PR #${number} nahi mila.`, action: "error" };
  if (cur.status_code !== 200) return { reply: `❌ PR fetch nahi hua (${cur.status_code}): ${ghMsg(cur)}`, action: "error" };
  const pr = cur.json();
  const st = stateLabel(pr);
  if (st === "merged") return { reply: `ℹ️ PR #${number} pehle hi merge ho chuka hai.`, action: "warning" };

  // ── CLOSE_PR ──
  if (cmd === "CLOSE_PR") {
    if (st === "closed") return { reply: `ℹ️ PR #${number} pehle se closed hai.`, action: "warning" };
    const r = await ghApi("PATCH", `/repos/${owner}/${repo}/pulls/${number}`, ghToken, { json: { state: "closed" } });
    if (r.status_code === 200) {
      return { reply: `🔴 PR #${number} close kar diya (merge nahi hua).\n🔗 ${r.json()?.html_url ?? ""}`, action: "pr_closed", repo: full, number };
    }
    if (r.status_code === 403 || r.status_code === 404) return { reply: `🔒 GitHub ne close allow nahi kiya (${r.status_code}): ${ghMsg(r)}`, action: "error" };
    return { reply: `❌ Close fail hua (${r.status_code}): ${ghMsg(r)}`, action: "error" };
  }

  // ── MERGE_PR ──
  if (st === "closed") return { reply: `ℹ️ PR #${number} closed hai — merge nahi ho sakta. Pehle reopen karo.`, action: "warning" };
  if (pr?.draft) return { reply: `📝 PR #${number} draft hai — merge se pehle usse "ready for review" karo.`, action: "warning" };

  const rawMethod = String(gd(p, "method", "squash") || "squash").toLowerCase();
  const method = rawMethod === "merge commit" ? "merge" : rawMethod;
  if (!MERGE_METHODS.includes(method)) {
    return { reply: `❌ Merge method \`${rawMethod}\` allowed nahi. Ye chuno: merge, squash, rebase.`, action: "error" };
  }
  const mr = await ghApi("PUT", `/repos/${owner}/${repo}/pulls/${number}/merge`, ghToken, {
    json: { merge_method: method, sha: pr?.head?.sha },
  });
  if (mr.status_code !== 200) return { reply: mergeError(mr.status_code, ghMsg(mr)), action: "error" };

  const head: string = pr?.head?.ref ?? "";
  const sameRepo = (pr?.head?.repo?.full_name ?? "").toLowerCase() === full.toLowerCase();
  let branchNote = "";
  let deleted = false;
  const wantDelete = p.delete_branch === true || String(p.delete_branch ?? "").toLowerCase() === "true";
  if (wantDelete && head && sameRepo && head !== (pr?.base?.ref ?? "")) {
    const d = await ghApi("DELETE", `/repos/${owner}/${repo}/git/refs/heads/${head.split("/").map(encodeURIComponent).join("/")}`, ghToken);
    if (d.status_code === 204) {
      deleted = true;
      branchNote = `\n🧹 Branch \`${head}\` delete ho gayi.`;
    } else {
      branchNote = `\n⚠️ Branch \`${head}\` delete nahi hui (${d.status_code}): ${ghMsg(d)}`;
    }
  } else if (head && sameRepo) {
    branchNote = `\n🧹 Branch bhi hatani ho to agli baar: \`merge pr ${number} in ${full} and delete branch\``;
  }
  return {
    reply: `🟣 PR #${number} merge ho gaya (${method}) → \`${pr?.base?.ref}\`.${branchNote}`,
    action: "pr_merged",
    repo: full,
    number,
    method,
    branch: head,
    branch_deleted: deleted,
  };
}
