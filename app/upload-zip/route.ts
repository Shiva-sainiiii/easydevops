/**
 * POST /upload-zip — zip extract -> ek commit me push (Git Data API: blobs -> tree -> commit -> ref).
 * Zip-slip fix: har entry ka path safeRepoPath() se guzarta hai.
 */
import { currentUser } from "@/lib/auth";
import { formFile, formStr, ghTokenOf, readForm } from "@/lib/api-utils";
import { ghApi } from "@/lib/providers/github";
import { safeJsonify, safeRepoPath, UnsafePathError } from "@/lib/security";
import { BadZipFile, ZipReader } from "@/lib/zip";
import { gd, K } from "@/lib/commands/pyutil";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

const MAX_ZIP_BYTES = 25 * 1024 * 1024;
const MAX_ZIP_ENTRIES = 300;

const err = (reply: string, status: number) => safeJsonify({ reply, action: "error", source: "direct" }, status);
const msgOf = (r: { content: Buffer; json(): any }, d: string) => (r.content.length ? gd(r.json(), "message", d) : d);

export async function POST(req: Request) {
  const user = await currentUser();
  if (!user) return err("❌ Login chahiye.", 401);
  const ghToken = ghTokenOf(user);
  const owner = user.github_login;

  const form = await readForm(req);
  const repo = formStr(form, "repo");
  const destDirRaw = formStr(form, "path").replace(/^\/+|\/+$/g, "");
  let message = formStr(form, "message");
  const f = formFile(form, "file");

  if (!repo) return err("❌ Repo naam nahi diya.", 400);
  if (!f || f.name === "") return err("❌ Koi zip file select nahi hui.", 400);
  if (!f.name.toLowerCase().endsWith(".zip")) {
    return err("❌ Ye zip file nahi lag rahi. `.zip` extension chahiye.", 400);
  }

  let destDir = "";
  if (destDirRaw) {
    try {
      destDir = safeRepoPath(destDirRaw);
    } catch (e: any) {
      if (e instanceof UnsafePathError) return err(`❌ Destination folder allowed nahi hai: ${e.message}`, 400);
      throw e;
    }
  }

  const raw = Buffer.from(await f.arrayBuffer());
  if (raw.length > MAX_ZIP_BYTES) {
    const sizeMb = raw.length / (1024 * 1024);
    return err(`❌ Zip bahut badi hai (${sizeMb.toFixed(1)} MB). 25MB tak hi supported hai.`, 413);
  }

  let zf: ZipReader;
  try {
    zf = new ZipReader(raw);
  } catch (e: any) {
    if (e instanceof BadZipFile) return err("❌ Zip file corrupt hai ya invalid format hai.", 400);
    throw e;
  }

  const entries = zf.namelist().filter((n) => !n.endsWith("/"));
  const topLevelParts = new Set(entries.filter((n) => n.includes("/")).map((n) => n.split("/")[0]));
  let entriesMap = new Map<string, string>();
  if (topLevelParts.size === 1 && entries.every((n) => n.startsWith(Array.from(topLevelParts)[0] + "/"))) {
    const stripPrefix = Array.from(topLevelParts)[0] + "/";
    for (const n of entries) entriesMap.set(n.slice(stripPrefix.length), n);
  } else {
    for (const n of entries) entriesMap.set(n, n);
  }

  const JUNK_PATTERNS = ["__MACOSX/", ".DS_Store", "Thumbs.db"];
  const cleaned = new Map<string, string>();
  for (const [clean, orig] of entriesMap) {
    if (clean && !JUNK_PATTERNS.some((j) => orig.includes(j))) cleaned.set(clean, orig);
  }
  entriesMap = cleaned;

  if (!entriesMap.size) return err("❌ Zip me koi usable file nahi mili.", 400);

  if (entriesMap.size > MAX_ZIP_ENTRIES) {
    return err(`❌ Zip me ${entriesMap.size} files hain — ${MAX_ZIP_ENTRIES} se zyada ek baar me support nahi hai.`, 413);
  }

  if (!message) message = `Extract ${f.name} via Easy DevOps (${entriesMap.size} files)`;

  const repoR = await ghApi("GET", `/repos/${owner}/${repo}`, ghToken);
  if (repoR.status_code !== 200) {
    return err(`❌ GitHub: ${msgOf(repoR, "Repo nahi mila")}`, repoR.status_code);
  }
  const defaultBranch = gd(repoR.json(), "default_branch", "main");

  const refR = await ghApi("GET", `/repos/${owner}/${repo}/git/ref/heads/${defaultBranch}`, ghToken);
  if (refR.status_code !== 200) return err("❌ Base branch ref nahi mila.", 400);
  const baseCommitSha = K(K(refR.json(), "object"), "sha");

  const baseCommitR = await ghApi("GET", `/repos/${owner}/${repo}/git/commits/${baseCommitSha}`, ghToken);
  if (baseCommitR.status_code !== 200) return err("❌ Base commit nahi mila.", 400);
  const baseTreeSha = K(K(baseCommitR.json(), "tree"), "sha");

  const treeEntries: any[] = [];
  const zipSkipped: string[] = [];
  for (const [cleanPath, origName] of entriesMap) {
    const rawFullPath = destDir ? `${destDir}/${cleanPath}` : cleanPath;
    let fullPath: string;
    try {
      fullPath = safeRepoPath(rawFullPath);
    } catch (e: any) {
      // Zip-slip: entry naam me "../" ho sakta hai — sirf ye entry skip, poora upload nahi
      if (e instanceof UnsafePathError) {
        zipSkipped.push(cleanPath);
        continue;
      }
      throw e;
    }
    const fileBytes = zf.read(origName);
    const blobR = await ghApi("POST", `/repos/${owner}/${repo}/git/blobs`, ghToken, {
      json: { content: fileBytes.toString("base64"), encoding: "base64" },
    });
    if (blobR.status_code !== 201) {
      return err(`❌ \`${cleanPath}\` upload karte time error: ${msgOf(blobR, "blob create failed")}`, 500);
    }
    treeEntries.push({ path: fullPath, mode: "100644", type: "blob", sha: K(blobR.json(), "sha") });
  }

  if (!treeEntries.length) {
    return err("❌ Zip me koi safe/usable file nahi mili (saare entries unsafe paths the).", 400);
  }

  const treeR = await ghApi("POST", `/repos/${owner}/${repo}/git/trees`, ghToken, {
    json: { base_tree: baseTreeSha, tree: treeEntries },
  });
  if (treeR.status_code !== 201) return err(`❌ Tree create Error: ${msgOf(treeR, "tree create failed")}`, 500);
  const newTreeSha = K(treeR.json(), "sha");

  const commitR = await ghApi("POST", `/repos/${owner}/${repo}/git/commits`, ghToken, {
    json: { message, tree: newTreeSha, parents: [baseCommitSha] },
  });
  if (commitR.status_code !== 201) return err(`❌ Commit create Error: ${msgOf(commitR, "commit create failed")}`, 500);
  const newCommitSha = K(commitR.json(), "sha");

  const updateRefR = await ghApi("PATCH", `/repos/${owner}/${repo}/git/refs/heads/${defaultBranch}`, ghToken, {
    json: { sha: newCommitSha },
  });
  if (updateRefR.status_code !== 200) {
    return err(`❌ Branch update Error: ${msgOf(updateRefR, "ref update failed")}`, 500);
  }

  const repoUrl = gd(repoR.json(), "html_url", "");
  const destDisplay = destDir ? `${repo}/${destDir}` : repo;
  const sortedKeys = Array.from(entriesMap.keys()).sort();
  const fileListPreview = sortedKeys.slice(0, 15).map((p) => `• ${p}`).join("\n");
  const moreNote = entriesMap.size > 15 ? `\n… +${entriesMap.size - 15} more` : "";
  const skipNote = zipSkipped.length ? `\n\n⚠️ Unsafe path hone ki wajah se skip hui: ${zipSkipped.join(", ")}` : "";

  return safeJsonify({
    reply: `✅ Zip extract ho gayi aur push ho gayi!\n**${treeEntries.length} files** → \`${destDisplay}\`\n\n${fileListPreview}${moreNote}${skipNote}\n\n🔗 ${repoUrl}/tree/${defaultBranch}/${destDir ? destDir : ""}`,
    action: "create_file",
    repo,
    source: "direct",
    file_count: treeEntries.length,
  });
}
