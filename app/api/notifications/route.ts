import { currentUser } from "@/lib/auth";
import { ghTokenOf } from "@/lib/api-utils";
import { ghApi } from "@/lib/providers/github";
import { safeJsonify } from "@/lib/security";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 30;

const REASON: Record<string, string> = {
  review_requested: "review maanga gaya", mention: "tumhe mention kiya", team_mention: "team mention",
  assign: "tumhe assign kiya", author: "tumhare PR/issue pe activity", comment: "naya comment",
  state_change: "merge/close hua", ci_activity: "CI result", invitation: "invitation",
  subscribed: "watching repo", manual: "subscribed", security_alert: "security alert",
};
const ICON: Record<string, string> = {
  PullRequest: "🔀", Issue: "🐞", Commit: "📝", CheckSuite: "⚙️", Release: "🏷️", Discussion: "💬", RepositoryInvitation: "📨",
};

function htmlUrl(n: any): string {
  const repoUrl: string = n?.repository?.html_url ?? "";
  const num = /\/(?:pulls|issues)\/(\d+)$/.exec(n?.subject?.url ?? "")?.[1];
  if (n?.subject?.type === "PullRequest" && num) return `${repoUrl}/pull/${num}`;
  if (n?.subject?.type === "Issue" && num) return `${repoUrl}/issues/${num}`;
  if (n?.subject?.type === "RepositoryInvitation") return `${repoUrl}/invitations`;
  return repoUrl;
}

const withTimeout = <T,>(p: Promise<T>, ms = 6000): Promise<T | null> =>
  Promise.race([p, new Promise<null>((res) => setTimeout(() => res(null), ms))]);

/** GET: header bell ka data — pending repo invites + unread GitHub notifications. Har part fail-safe. */
export async function GET() {
  const user = await currentUser();
  if (!user) return safeJsonify({ logged_in: false }, 401);
  const gh = ghTokenOf(user);

  let invitations: any[] = [];
  let notifications: any[] = [];
  try {
    const [inv, nts] = await Promise.all([
      withTimeout(ghApi("GET", "/user/repository_invitations?per_page=30", gh)),
      withTimeout(ghApi("GET", "/notifications?all=false&per_page=30", gh)),
    ]);
    if (inv && inv.status_code === 200 && Array.isArray(inv.json())) {
      invitations = inv.json()
        .filter((i: any) => !i?.expired)
        .map((i: any) => ({
          id: i.id,
          repo: i?.repository?.full_name ?? "",
          inviter: i?.inviter?.login ?? "",
          permission: ({ write: "push", read: "pull" } as Record<string, string>)[i?.permissions] ?? i?.permissions ?? "push",
          private: !!i?.repository?.private,
        }));
    }
    if (nts && nts.status_code === 200 && Array.isArray(nts.json())) {
      notifications = nts.json()
        // Invite notification bell me alag section me aata hai, double na dikhe
        .filter((n: any) => n?.subject?.type !== "RepositoryInvitation")
        .map((n: any) => ({
          id: n.id,
          unread: !!n.unread,
          icon: ICON[n?.subject?.type] ?? "🔔",
          title: n?.subject?.title ?? "",
          repo: n?.repository?.full_name ?? "",
          reason_label: REASON[n.reason] ?? n.reason ?? "",
          url: htmlUrl(n),
          updated_at: n.updated_at ?? null,
        }));
    }
  } catch {
    // ignore — bell khaali dikhega, app nahi bigadna chahiye
  }
  const unread = invitations.length + notifications.filter((n) => n.unread).length;
  return safeJsonify({ logged_in: true, invitations, notifications, unread });
}

/** POST {action:"read_all"}: saari GitHub notifications read mark. */
export async function POST(req: Request) {
  const user = await currentUser();
  if (!user) return safeJsonify({ ok: false }, 401);
  let body: any = {};
  try { body = await req.json(); } catch { /* empty */ }
  if (body?.action !== "read_all") return safeJsonify({ ok: false, error: "unknown action" }, 400);
  const r = await ghApi("PUT", "/notifications", ghTokenOf(user), { json: { last_read_at: new Date().toISOString(), read: true } });
  return safeJsonify({ ok: [200, 202, 205].includes(r.status_code) });
}
