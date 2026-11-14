/**
 * COLLABORATION (Phase 1 — owner side): collaborator invite / list / remove / invite cancel.
 *
 * Sab kuch calling user ke apne GitHub token se chalta hai; permission ka final faisla GitHub
 * karta hai. Hum bas pehle `GET /repos/{o}/{r}` se permissions padh ke saaf Hinglish error dete hain.
 * Vercel/Netlify/Render ke tokens yahan kabhi nahi aate.
 */
import { req } from "@/lib/commands/pyutil";
import { ghApi, ghListAllRepos, ghMsg, ghRepoAccess, parseRepoRef, sameLogin, type RepoAccess } from "@/lib/providers/github";

export const COLLAB_COMMANDS = new Set([
  "INVITE_COLLABORATOR",
  "LIST_COLLABORATORS",
  "REMOVE_COLLABORATOR",
  "CANCEL_INVITE",
]);

/**
 * Friend side (Phase 2): mujhe aaye invites accept/decline + mere saath share kiye gaye repos.
 * Inme `repo` param pe `owner/repo` resolution / access-check NAHI lagta (private repo ka access
 * invite accept karne se PEHLE hota hi nahi) — isliye executor/guard dono inhe alag se chhodte hain.
 */
export const FRIEND_COMMANDS = new Set([
  "LIST_MY_INVITATIONS",
  "ACCEPT_INVITATION",
  "DECLINE_INVITATION",
  "LIST_SHARED_REPOS",
]);

type Result = Record<string, any>;

/**
 * Doosre owner ke repo (`owner/repo`) pe abhi sirf ye commands allowed hain: read-only +
 * collaborator management. Write commands (file edit, PR, delete...) Phase 3 me aayenge
 * (branch-safe default ke saath), tab tak block hain.
 */
export const FOREIGN_OWNER_COMMANDS = new Set([
  "LIST_FILES", "READ_FILE", "GET_REPO_INFO", "GITHUB_CHECK_STATUS",
  ...COLLAB_COMMANDS,
]);

/**
 * /chat route ke liye early guard (confirm prompt / AI codegen se PEHLE chalta hai).
 * - galat `owner/repo` -> error result
 * - apna hi `me/repo` -> params.repo ko plain `repo` bana deta hai (purane handlers ke liye)
 * - doosre ka repo + write command -> block result
 * Warna null (aage badho). CREATE_REPO ko touch nahi karta (purana naam-sanitize behaviour).
 */
export function guardRepoParam(cmd: string, p: Record<string, any>, selfLogin: string): Result | null {
  if (cmd === "CREATE_REPO" || FRIEND_COMMANDS.has(cmd) || !p || typeof p.repo !== "string" || !p.repo.includes("/")) {
    return null;
  }
  const ref = parseRepoRef(p.repo, selfLogin);
  if (!ref) {
    return { reply: `❌ Repo naam galat hai: \`${p.repo}\`. Format: \`repo\` ya \`owner/repo\`.`, action: "error" };
  }
  if (sameLogin(ref.owner, selfLogin)) {
    p.repo = ref.repo;
    return null;
  }
  if (!FOREIGN_OWNER_COMMANDS.has(cmd)) {
    return {
      reply:
        `🔒 \`${ref.owner}/${ref.repo}\` doosre ka repo hai — abhi uspe sirf dekhna (files/info/checks) ` +
        `aur collaborators manage karna allowed hai. Edit/PR/delete jaise kaam baad ke update me aayenge.`,
      action: "warning",
    };
  }
  return null;
}

const USER_RE = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})$/;
const ALLOWED_PERMS = ["pull", "triage", "push", "maintain"];
const PERM_ALIASES: Record<string, string> = { read: "pull", write: "push" };
// GitHub invitations API `permissions` (write/read) ko apne naam me dikhane ke liye
const INVITE_PERM_LABEL: Record<string, string> = { write: "push", read: "pull" };

const cleanUser = (raw: any): string => String(raw ?? "").trim().replace(/^@+/, "");

function badUsername(u: string): Result | null {
  if (USER_RE.test(u)) return null;
  return { reply: `❌ \`${u}\` valid GitHub username nahi lag raha (sirf letters, numbers aur hyphen).`, action: "error" };
}

/** Admin zaroori hai; warna saaf error. Returns [access, null] ya [null, errorResult]. */
async function requireAdmin(owner: string, repo: string, ghToken: string): Promise<[RepoAccess | null, Result | null]> {
  const [acc, err] = await ghRepoAccess(owner, repo, ghToken);
  if (!acc) return [null, { reply: err, action: "error" }];
  if (!acc.admin) {
    return [
      null,
      {
        reply:
          `🔒 Collaborators manage karne ke liye repo ka **admin** hona zaroori hai. ` +
          `\`${owner}/${repo}\` pe tumhari permission: **${acc.role}**.`,
        action: "warning",
      },
    ];
  }
  return [acc, null];
}

async function listInvites(owner: string, repo: string, ghToken: string): Promise<any[] | null> {
  const r = await ghApi("GET", `/repos/${owner}/${repo}/invitations?per_page=100`, ghToken);
  if (r.status_code !== 200) return null;
  const data = r.json();
  return Array.isArray(data) ? data : null;
}

export async function executeCollabCommand(
  cmd: string,
  p: Record<string, any>,
  owner: string,
  ghToken: string
): Promise<Result> {
  const repo = String(req(p, "repo")).trim();
  const full = `${owner}/${repo}`;

  // ── LIST ──
  if (cmd === "LIST_COLLABORATORS") {
    const [acc, err] = await ghRepoAccess(owner, repo, ghToken);
    if (!acc) return { reply: err, action: "error" };
    if (!acc.push) {
      return {
        reply: `🔒 Collaborators ki list dekhne ke liye kam se kam **push** access chahiye. \`${full}\` pe tumhari permission: **${acc.role}**.`,
        action: "warning",
      };
    }
    const r = await ghApi("GET", `/repos/${owner}/${repo}/collaborators?per_page=100&affiliation=direct`, ghToken);
    if (r.status_code !== 200) {
      return { reply: `❌ Collaborators fetch nahi hue (${r.status_code}): ${ghMsg(r)}`, action: "error" };
    }
    const collabs: any[] = r.json();
    const people = collabs.map((c) => ({
      login: c.login,
      role: c.role_name ?? (c.permissions?.admin ? "admin" : c.permissions?.push ? "push" : "pull"),
    }));
    // Pending invites sirf admin dekh sakta hai; fail ho to chup-chaap skip
    const invitesRaw = acc.admin ? await listInvites(owner, repo, ghToken) : null;
    const pending = (invitesRaw ?? []).map((i) => ({
      login: i?.invitee?.login,
      permission: INVITE_PERM_LABEL[i?.permissions] ?? i?.permissions,
    }));

    let reply = `👥 **${full}** — ${people.length} collaborator${people.length !== 1 ? "s" : ""}`;
    if (people.length) reply += "\n" + people.map((c) => `• @${c.login} — ${c.role}`).join("\n");
    if (acc.admin) {
      reply += `\n\n📨 Pending invites: ${pending.length}`;
      if (pending.length) reply += "\n" + pending.map((i) => `• @${i.login} — ${i.permission}`).join("\n");
    }
    if (people.length >= 100) reply += "\n\n(Sirf pehle 100 dikhaye gaye.)";
    return { reply, action: "collab_list", repo: full, collaborators: people, pending_invites: pending };
  }

  // Baaki teeno commands ko username chahiye aur admin access
  const username = cleanUser(req(p, "username"));
  const bad = badUsername(username);
  if (bad) return bad;
  const [acc, adminErr] = await requireAdmin(owner, repo, ghToken);
  if (!acc) return adminErr as Result;

  // ── INVITE ──
  if (cmd === "INVITE_COLLABORATOR") {
    if (sameLogin(username, owner)) {
      return { reply: "ℹ️ Ye to repo ka owner hai, usse invite karne ki zaroorat nahi.", action: "warning" };
    }
    let perm = "push";
    const rawPerm = p.permission;
    const explicit = rawPerm !== undefined && rawPerm !== null && String(rawPerm).trim() !== "";
    if (explicit) {
      const pl = String(rawPerm).trim().toLowerCase();
      perm = PERM_ALIASES[pl] ?? pl;
      if (!ALLOWED_PERMS.includes(perm)) {
        return {
          reply: `❌ Permission \`${pl}\` allowed nahi. Ye chuno: pull (read), triage, push (write), maintain. (Admin access chat se nahi diya jata.)`,
          action: "error",
        };
      }
    }
    // Personal (User) repos pe GitHub permission field ignore karke hamesha write deta hai —
    // user ne kam maanga ho to chupke se zyada access dena sahi nahi.
    if (acc.ownerType !== "Organization" && perm !== "push") {
      return {
        reply:
          `⚠️ \`${full}\` personal repo hai — GitHub personal repo pe sirf **push (write)** access deta hai, ` +
          `\`${perm}\` alag se nahi de sakta. \`push\` se invite karna ho to bolo.`,
        action: "warning",
      };
    }

    const u = await ghApi("GET", `/users/${username}`, ghToken);
    if (u.status_code === 404) return { reply: `❌ GitHub user \`${username}\` nahi mila. Username check karo.`, action: "error" };
    if (u.status_code !== 200) return { reply: `❌ User check fail hua (${u.status_code}): ${ghMsg(u)}`, action: "error" };
    const login: string = u.json().login ?? username;
    if (u.json().type && u.json().type !== "User") {
      return { reply: `❌ \`${login}\` ek ${u.json().type} account hai — sirf individual user ko invite kar sakte hain.`, action: "error" };
    }

    const r = await ghApi("PUT", `/repos/${owner}/${repo}/collaborators/${login}`, ghToken, { json: { permission: perm } });
    if (r.status_code === 201) {
      const inv = r.json();
      const link = inv?.html_url ? `\n🔗 ${inv.html_url}` : "";
      return {
        reply:
          `📨 Invite bhej diya — **@${login}** ko \`${full}\` me \`${perm}\` access ke saath.\n` +
          `Wo GitHub notification/email se ya neeche ke link se accept kar sakta hai (invite kuch din me expire ho jata hai).${link}`,
        action: "collab_invite",
        repo: full,
        username: login,
        permission: perm,
      };
    }
    if (r.status_code === 204) {
      return {
        reply: `✅ **@${login}** pehle se \`${full}\` ka collaborator hai (access: \`${perm}\`).`,
        action: "collab_invite",
        repo: full,
        username: login,
        permission: perm,
      };
    }
    if (r.status_code === 403) return { reply: `🔒 GitHub ne invite allow nahi kiya (403): ${ghMsg(r)}`, action: "error" };
    if (r.status_code === 404) return { reply: `❌ Invite nahi gaya (404): repo ya user nahi mila.`, action: "error" };
    return { reply: `❌ Invite fail hua (${r.status_code}): ${ghMsg(r)}`, action: "error" };
  }

  // ── REMOVE ──
  if (cmd === "REMOVE_COLLABORATOR") {
    if (sameLogin(username, owner)) {
      return { reply: "❌ Owner ko collaborators se hata nahi sakte.", action: "error" };
    }
    const chk = await ghApi("GET", `/repos/${owner}/${repo}/collaborators/${username}`, ghToken);
    if (chk.status_code === 404) {
      return {
        reply: `ℹ️ **@${username}** \`${full}\` ka collaborator nahi hai. Agar invite pending hai to "cancel invite" bolo.`,
        action: "warning",
      };
    }
    if (chk.status_code !== 204) {
      return { reply: `❌ Check fail hua (${chk.status_code}): ${ghMsg(chk)}`, action: "error" };
    }
    const r = await ghApi("DELETE", `/repos/${owner}/${repo}/collaborators/${username}`, ghToken);
    if (r.status_code === 204) {
      return { reply: `🗑️ **@${username}** ko \`${full}\` se hata diya. Ab uska access band hai.`, action: "collab_remove", repo: full, username };
    }
    if (r.status_code === 403) return { reply: `🔒 GitHub ne remove allow nahi kiya (403): ${ghMsg(r)}`, action: "error" };
    return { reply: `❌ Remove fail hua (${r.status_code}): ${ghMsg(r)}`, action: "error" };
  }

  // ── CANCEL INVITE ──
  if (cmd === "CANCEL_INVITE") {
    const invites = await listInvites(owner, repo, ghToken);
    if (invites === null) return { reply: "❌ Pending invites fetch nahi hue. Thodi der baad try karo.", action: "error" };
    const hit = invites.find((i) => sameLogin(i?.invitee?.login ?? "", username));
    if (!hit) return { reply: `ℹ️ **@${username}** ka \`${full}\` me koi pending invite nahi mila.`, action: "warning" };
    const r = await ghApi("DELETE", `/repos/${owner}/${repo}/invitations/${hit.id}`, ghToken);
    if (r.status_code === 204) {
      return { reply: `↩️ **@${username}** ka invite cancel ho gaya (\`${full}\`).`, action: "collab_cancel_invite", repo: full, username };
    }
    return { reply: `❌ Invite cancel nahi hua (${r.status_code}): ${ghMsg(r)}`, action: "error" };
  }

  return { reply: `❌ Unknown collaboration command: ${cmd}`, action: "error" };
}


// ════════════════════════════════════════════════════════════════
// FRIEND SIDE — invitations + shared repos
// ════════════════════════════════════════════════════════════════

const mapInvite = (i: any) => ({
  id: i?.id,
  repo: i?.repository?.full_name ?? "",
  owner: i?.repository?.owner?.login ?? "",
  inviter: i?.inviter?.login ?? "",
  permission: INVITE_PERM_LABEL[i?.permissions] ?? i?.permissions ?? "",
  private: !!i?.repository?.private,
  url: i?.html_url ?? "",
  expired: !!i?.expired,
  created_at: i?.created_at ?? null,
});

async function fetchMyInvites(ghToken: string): Promise<[ReturnType<typeof mapInvite>[] | null, string | null]> {
  const r = await ghApi("GET", "/user/repository_invitations?per_page=100", ghToken);
  if (r.status_code === 401) return [null, "🔒 GitHub token invalid ya expire ho gaya. Logout karke dubara GitHub se connect karo."];
  if (r.status_code !== 200) return [null, `❌ Invitations fetch nahi hue (${r.status_code}): ${ghMsg(r)}`];
  const data = r.json();
  return [Array.isArray(data) ? data.map(mapInvite) : [], null];
}

export async function executeFriendCommand(cmd: string, p: Record<string, any>, ghToken: string): Promise<Result> {
  // ── LIST_MY_INVITATIONS ──
  if (cmd === "LIST_MY_INVITATIONS") {
    const [all, err] = await fetchMyInvites(ghToken);
    if (!all) return { reply: err, action: "error" };
    const live = all.filter((i) => !i.expired);
    const expiredCount = all.length - live.length;
    if (!live.length) {
      return {
        reply: "📭 Abhi koi pending invitation nahi hai." + (expiredCount ? ` (${expiredCount} expire ho chuke hain — owner se dobara invite maango.)` : ""),
        action: "invitations",
        invitations: [],
      };
    }
    const lines = live.map(
      (i) =>
        `• **${i.repo}** — @${i.inviter} ne bheja — \`${i.permission}\`${i.private ? " — private" : ""}\n` +
        `  ✅ \`accept invite ${i.repo}\`  ·  ❌ \`decline invite ${i.repo}\``
    );
    let reply = `📨 Tumhare ${live.length} pending invitation${live.length !== 1 ? "s" : ""}:\n\n` + lines.join("\n");
    if (expiredCount) reply += `\n\n(${expiredCount} aur invite expire ho chuke hain.)`;
    return { reply, action: "invitations", invitations: live };
  }

  // ── LIST_SHARED_REPOS ──
  if (cmd === "LIST_SHARED_REPOS") {
    const [repos, r] = await ghListAllRepos(ghToken, 100, 300, "collaborator");
    if (r === null || r.status_code !== 200) return { reply: "❌ Shared repos fetch nahi hue.", action: "error" };
    // Apne hi repos (agar kabhi aa jaayein) ko hata do
    const shared = repos.filter((rp) => rp?.owner?.login);
    if (!shared.length) {
      return { reply: "🤝 Abhi kisi ne tumhe apne repo me collaborator nahi banaya.", action: "list_shared_repos", repos: [] };
    }
    const roleOf = (rp: any) =>
      rp.permissions?.admin ? "admin" : rp.permissions?.maintain ? "maintain" : rp.permissions?.push ? "push" : rp.permissions?.triage ? "triage" : "pull";
    const lines = shared.map(
      (rp) =>
        `📁 **${rp.full_name}** — @${rp.owner.login} ka repo — \`${roleOf(rp)}\` — \`${rp.private ? "private" : "public"}\`\n🔗 ${rp.html_url}`
    );
    const reply =
      `🤝 Tumhare saath share kiye gaye ${shared.length} repo${shared.length !== 1 ? "s" : ""}:\n\n` +
      lines.join("\n\n") +
      "\n\n💡 Inpe abhi dekhna possible hai, jaise: `list files in owner/repo`, `info about owner/repo`.";
    return {
      reply,
      action: "list_shared_repos",
      repos: shared.map((rp) => ({
        full_name: rp.full_name,
        owner: rp.owner.login,
        name: rp.name,
        url: rp.html_url,
        permission: roleOf(rp),
        private: !!rp.private,
      })),
    };
  }

  // ── ACCEPT / DECLINE ──
  const raw = String(req(p, "repo")).trim().toLowerCase();
  if (!raw) return { reply: "❌ Kaunsa invite? `accept invite owner/repo` likho.", action: "error" };
  const [all, err] = await fetchMyInvites(ghToken);
  if (!all) return { reply: err, action: "error" };
  const matches = all.filter((i) => (raw.includes("/") ? i.repo.toLowerCase() === raw : i.repo.toLowerCase().split("/")[1] === raw));
  if (!matches.length) {
    return {
      reply: `ℹ️ \`${raw}\` ka koi pending invitation nahi mila. "my invitations" bolke list dekho.`,
      action: "warning",
    };
  }
  if (matches.length > 1) {
    return {
      reply: `⚠️ \`${raw}\` naam ke ${matches.length} invites hain: ${matches.map((m) => `\`${m.repo}\``).join(", ")}. \`owner/repo\` form me likho.`,
      action: "warning",
    };
  }
  const inv = matches[0];
  if (inv.expired) {
    return { reply: `⌛ \`${inv.repo}\` ka invite expire ho chuka hai. @${inv.inviter} se dobara invite bhejne ko bolo.`, action: "warning" };
  }

  if (cmd === "ACCEPT_INVITATION") {
    const r = await ghApi("PATCH", `/user/repository_invitations/${inv.id}`, ghToken);
    if (r.status_code === 204) {
      return {
        reply:
          `✅ Invite accept ho gaya — ab tum \`${inv.repo}\` ke collaborator ho (\`${inv.permission}\` access).\n` +
          `Try karo: \`list files in ${inv.repo}\` ya \`info about ${inv.repo}\`.`,
        action: "invite_accepted",
        repo: inv.repo,
        permission: inv.permission,
      };
    }
    if (r.status_code === 404 || r.status_code === 410) {
      return { reply: `⌛ Invite ab valid nahi hai (expire ho gaya ya owner ne wapas le liya). @${inv.inviter} se dobara bhejne ko bolo.`, action: "warning" };
    }
    if (r.status_code === 403) return { reply: `🔒 GitHub ne accept allow nahi kiya (403): ${ghMsg(r)}`, action: "error" };
    return { reply: `❌ Accept fail hua (${r.status_code}): ${ghMsg(r)}`, action: "error" };
  }

  if (cmd === "DECLINE_INVITATION") {
    const r = await ghApi("DELETE", `/user/repository_invitations/${inv.id}`, ghToken);
    if (r.status_code === 204) {
      return { reply: `🚫 \`${inv.repo}\` ka invite decline kar diya.`, action: "invite_declined", repo: inv.repo };
    }
    if (r.status_code === 404 || r.status_code === 410) {
      return { reply: "ℹ️ Ye invite pehle hi hat chuka hai.", action: "warning" };
    }
    return { reply: `❌ Decline fail hua (${r.status_code}): ${ghMsg(r)}`, action: "error" };
  }

  return { reply: `❌ Unknown command: ${cmd}`, action: "error" };
}
