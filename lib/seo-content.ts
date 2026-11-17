/**
 * SEO content pages ka saara text — data ke roop me (components/seo/ContentPage.tsx render karta hai).
 * Inline syntax: [text](/path) = link, `code` = code.
 * Note: claims product ke asli behavior se match karte hain (rules-first parser, confirm before destructive,
 * encrypted tokens, user's own AI key). Naya feature ya policy badle to yahan update karo.
 */
export interface Section {
  id: string;
  h2: string;
  p?: string[];
  ul?: string[];
  ol?: string[];
  table?: { head: string[]; rows: string[][] };
  code?: string;
}
export interface FaqItem {
  q: string;
  a: string;
}
export interface PageDef {
  key: string;
  path: string;
  /** <title> (layout template " | Easy DevOps" lagata hai) */
  title: string;
  h1: string;
  description: string;
  lead: string;
  sections: Section[];
  faq?: FaqItem[];
  kind: "page" | "article" | "about";
  updated: string;
  related: string[];
}

export const FAQ: FaqItem[] = [
  {
    q: "What is Easy DevOps?",
    a: "Easy DevOps is a chat-based tool that lets you create GitHub repositories, deploy to Vercel, Netlify and Render, set environment variables and manage pull requests by typing plain English or Hinglish. You sign in with GitHub, connect the platforms you use, and run everything from one chat window instead of learning the command line.",
  },
  {
    q: "Who is Easy DevOps for?",
    a: "It is built for students and upcoming developers who want to ship projects without learning git, the Vercel CLI or Render dashboards first. It also suits anyone who wants to do quick DevOps chores, like creating a repo, pushing a file and deploying, from a phone or a browser tab.",
  },
  {
    q: "Do I need to know the CLI or git commands?",
    a: "No. You type what you want, for example \"create repo portfolio\" or \"deploy portfolio to vercel\", and Easy DevOps runs the matching GitHub, Vercel, Netlify or Render API calls on your connected accounts. You can learn the underlying commands later; nothing is hidden from you.",
  },
  {
    q: "Which platforms does Easy DevOps support?",
    a: "GitHub (repositories, files, branches, pull requests, collaborators), Vercel (import, deploy, environment variables, rollback), Netlify (sites, deploy, environment variables) and Render (services, deploy, environment variables, render.yaml generation). You connect each platform with your own account or token.",
  },
  {
    q: "Is Easy DevOps free to use?",
    a: "Signing in with GitHub and using the rule-based commands costs nothing. The optional AI features run on your own API key through the AI Gateway (for example a Google AI Studio or OpenRouter key), so you stay in control of any AI usage and cost.",
  },
  {
    q: "Does Easy DevOps use AI for every message?",
    a: "No. Most commands, like creating a repo, listing projects or deploying, are understood by a fast rule-based parser with zero AI calls. AI is used only for complex tasks, such as generating code or planning an unusual request. Every reply shows a badge so you can see whether it ran on rules or used AI.",
  },
  {
    q: "How is Easy DevOps different from asking ChatGPT or Claude about DevOps?",
    a: "A general chatbot only tells you which commands to run. Easy DevOps actually performs the action on your GitHub, Vercel, Netlify or Render account, asks for confirmation before anything destructive, and shows live results such as build logs. It is an agent with hands, not just advice.",
  },
  {
    q: "Is it safe to connect my GitHub and Vercel accounts?",
    a: "Provider tokens and AI keys are encrypted at rest, sign-in uses GitHub OAuth, requests are rate limited, and destructive actions such as deleting a repo or rolling back a deployment always need your explicit confirmation. You can revoke access at any time from your GitHub, Vercel, Netlify or Render settings.",
  },
  {
    q: "Can it delete my repositories by accident?",
    a: "Deleting repos, files or projects, merging pull requests and rollbacks always show a confirmation first. Confirmations expire after 15 minutes and work only once. If you send several tasks in one message and one of them is destructive, you approve the whole plan once before anything runs.",
  },
  {
    q: "Does Easy DevOps understand Hindi or Hinglish?",
    a: "Yes. You can write in English, Hinglish or a mix, for example \"bhai ek repo bna de practice naam se\" or \"repo old-project delete karo\". The command parser recognises many common Hinglish phrasings, and when a message is not covered, the optional AI fallback can still work out what you mean.",
  },
  {
    q: "Can I give several tasks in one message?",
    a: "Yes. A message like \"create a repo named practice, add index.html with this code and deploy it to Vercel\" is split into ordered steps and run one after another. Pasted code is kept as-is and never sent to an AI. If a step fails, the plan stops and shows exactly which step failed.",
  },
  {
    q: "How do I deploy a GitHub repo to Vercel without the CLI?",
    a: "Connect your Vercel account once, then type \"deploy my-repo to vercel\". If the repo has not been imported yet, Easy DevOps imports it first and then triggers the deployment. See the step-by-step guide on [deploying to Vercel without the CLI](/guides/deploy-to-vercel-without-cli).",
  },
  {
    q: "Can I set environment variables from chat?",
    a: "Yes. You can set variables on Vercel, Netlify and Render with a message like \"set env API_KEY=value in my-app on vercel\", or upload a .env file to import many variables at once.",
  },
  {
    q: "What happens if my deployment fails?",
    a: "Easy DevOps streams live build logs while a Vercel deployment runs. If the build fails, it highlights the error and, when an AI key is configured, explains the likely cause in plain language so you know what to fix.",
  },
  {
    q: "Can Easy DevOps write code for me?",
    a: "Yes, as an optional AI feature. Describe a change such as \"add a navbar in my-repo\" and it generates the code on a new branch and opens a pull request so you can review before merging. This uses your own AI key.",
  },
  {
    q: "Which AI providers can I use?",
    a: "The AI Gateway supports Google AI Studio and OpenRouter keys. You add your own key in the app, and the usage dashboard shows how many AI calls were made per minute, day and month so you can stay inside free-tier limits.",
  },
  {
    q: "Can I upload files, folders or a zip to a repository?",
    a: "Yes. You can attach files, a folder or a zip and push them into a GitHub repo, and add a custom instruction along with the upload. You can also upload a .env file to bulk-import environment variables.",
  },
  {
    q: "Is my chat history stored?",
    a: "Chats are stored so they can sync across your devices. The usage dashboard stores only counts and metadata, such as provider, model and timestamps, never your messages or AI replies. Details are on the [privacy page](/privacy).",
  },
  {
    q: "How do I disconnect Easy DevOps or remove my data?",
    a: "Use Log Out in the app to disconnect and remove your stored provider tokens and AI keys. You can also revoke the OAuth authorisation from your GitHub settings, and revoke tokens from Vercel, Netlify or Render directly.",
  },
];

export const PAGES: Record<string, PageDef> = {
  features: {
    key: "features",
    path: "/features",
    title: "Features: deploy from chat to Vercel, Netlify & Render",
    h1: "Everything you can do from one chat",
    description:
      "Create GitHub repos, deploy to Vercel, Netlify and Render, manage env vars and pull requests from a single chat. Rules-first, AI only when needed.",
    lead: "Easy DevOps turns the usual DevOps chores into short chat messages. Here is what you can do without opening a terminal or switching between four dashboards.",
    kind: "page",
    updated: "2026-11-16",
    related: ["how-it-works", "commands", "faq"],
    sections: [
      {
        id: "github",
        h2: "GitHub: repos, files, branches and pull requests",
        p: ["Create and delete repositories, create, edit and delete files, upload files, folders or a zip, create branches, open and merge pull requests, comment on them, and invite collaborators. Every destructive action asks for confirmation first."],
        ul: [
          "Create a repo with one sentence, in English or Hinglish",
          "Push a pasted file such as index.html straight into a repo",
          "Open, review, merge or close pull requests from chat",
          "Check CI status of a repository",
        ],
      },
      {
        id: "vercel",
        h2: "Vercel: import, deploy, env vars and rollback",
        p: ["Import a GitHub repo into Vercel, trigger deployments, watch live build logs, set environment variables (or bulk-import a .env file) and roll back to a previous deployment. If the build fails, the error is highlighted and explained in plain language when an AI key is configured."],
      },
      {
        id: "netlify-render",
        h2: "Netlify and Render in the same place",
        p: ["Deploy Netlify sites, manage Netlify and Render environment variables, create and deploy Render services, and generate a render.yaml blueprint for a repo. You do not need to learn three different dashboards."],
      },
      {
        id: "multi-step",
        h2: "Multi-step requests in one message",
        p: ["Write several tasks in one message and they run in order: for example create a repo, add a file with your pasted code and deploy it. Simple multi-step requests are split by rules with no AI call. See [how it works](/how-it-works)."],
      },
      {
        id: "rules-first",
        h2: "Rules first, AI only when needed",
        p: ["Around 80 to 90 percent of everyday commands are handled by a fast rule-based parser. AI is used for genuinely complex tasks such as code generation. Each reply is labelled so you always know whether AI was involved, and a usage dashboard tracks requests per minute, day and month against your free limits."],
      },
      {
        id: "safety",
        h2: "Built to be safe for beginners",
        ul: [
          "Confirmation before deleting, merging or rolling back",
          "Provider tokens and AI keys encrypted at rest",
          "GitHub OAuth sign-in, revocable any time",
          "Rate limits and origin checks on every request",
        ],
      },
      {
        id: "hinglish",
        h2: "Understands Hinglish",
        p: ["Write the way you speak, for example \"bhai ek repo bna de practice naam se\" or \"mere saare repos dikhao\". The parser understands many common Hinglish phrasings, and follow-ups such as \"phir isko deploy kar do\" work inside a multi-step message, so beginners are not forced into exact syntax."],
      },
    ],
  },

  "how-it-works": {
    key: "how-it-works",
    path: "/how-it-works",
    title: "How Easy DevOps works: rules first, AI only when needed",
    h1: "How Easy DevOps works",
    description:
      "How a chat message becomes a GitHub, Vercel, Netlify or Render action: rule-based parsing first, an AI planner only for complex tasks, confirmation for risks.",
    lead: "Easy DevOps is designed so that the fast, predictable path handles most requests and AI is a fallback, not the default. Here is the full flow from your message to a finished action.",
    kind: "page",
    updated: "2026-11-16",
    related: ["features", "faq", "privacy"],
    sections: [
      {
        id: "flow",
        h2: "From message to action",
        ol: [
          "You sign in with GitHub and connect Vercel, Netlify or Render with your own account or token.",
          "You send a message such as \"create repo portfolio\" or \"deploy portfolio to vercel\".",
          "The rule-based parser matches it to a command. No AI call is made.",
          "Risky commands (delete, merge, rollback) show a confirmation card first.",
          "The command runs against the provider API using your own token, and the result appears in chat with live logs where relevant.",
        ],
      },
      {
        id: "multi-step",
        h2: "How multi-step messages are handled",
        p: [
          "If a message contains more than one task, Easy DevOps first lifts any pasted code out of the text so it is never altered or sent to an AI. It then splits the message at natural connectors such as \"and add\", \"then\", \"phir\" or a new line, and turns each part into a command using the same rules.",
          "When every part is understood, the steps run in order, and the first failure stops the plan with a clear checklist of what finished and what did not. If the message is genuinely ambiguous, a small AI planner call may be used to produce the plan, and its output is validated against a strict whitelist before anything runs.",
        ],
      },
      {
        id: "ai",
        h2: "When AI is used",
        p: [
          "AI is used for complex requests such as generating code, explaining a failed build or planning an unusual multi-step task. It runs on your own API key through the AI Gateway. Every reply shows a badge: Rules with zero AI, Rules plus AI, or AI.",
          "The usage dashboard inside the app tracks requests per minute, per day and per month and compares AI calls with the free limits you set.",
        ],
      },
      {
        id: "security",
        h2: "Security model",
        ul: [
          "Sign-in uses GitHub OAuth; sessions can be revoked.",
          "Provider tokens and AI keys are encrypted at rest.",
          "Destructive actions need confirmation tokens that are signed, expire after 15 minutes and work once.",
          "AI-suggested write actions always need your approval, which limits prompt-injection risk.",
          "Requests are rate limited and cross-site requests are rejected.",
        ],
      },
      {
        id: "stack",
        h2: "Who builds it",
        p: ["Easy DevOps is built and maintained by [Shiva Saini](/about), an independent full-stack developer."],
      },
    ],
  },

  commands: {
    key: "commands",
    path: "/commands",
    title: "Command examples in English & Hinglish",
    h1: "Easy DevOps command cookbook",
    description:
      "Copy-paste chat commands for GitHub, Vercel, Netlify and Render, in English and Hinglish: create repos, push files, deploy, set env vars, merge pull requests.",
    lead: "You do not need exact syntax, but these examples show the phrasing that is understood instantly by the rule-based parser, with no AI call.",
    kind: "page",
    updated: "2026-11-16",
    related: ["features", "faq", "guides/deploy-to-vercel-without-cli"],
    sections: [
      {
        id: "github",
        h2: "GitHub",
        table: {
          head: ["What you want", "English", "Hinglish"],
          rows: [
            ["List your repos", "list repos", "mere saare repos dikhao"],
            ["Create a repo", "create repo portfolio", "ek repo bna de portfolio naam se"],
            ["Delete a repo (asks to confirm)", "delete repo old-project", "repo old-project delete karo"],
            ["Create a file", "create file notes.txt in portfolio", "—"],
            ["Create a branch", "create branch dev in portfolio", "—"],
            ["Merge a pull request", "merge pr 3 in portfolio", "portfolio ka pr 3 merge kar do"],
            ["Invite a collaborator", "invite bob to portfolio", "bob ko portfolio me invite karo"],
          ],
        },
      },
      {
        id: "deploy",
        h2: "Vercel, Netlify and Render",
        table: {
          head: ["What you want", "English", "Hinglish"],
          rows: [
            ["Deploy to Vercel", "deploy portfolio to vercel", "—"],
            ["Import a repo into Vercel", "import portfolio to vercel", "—"],
            ["Set an env var", "set env API_KEY=abc123 in portfolio on vercel", "—"],
            ["Roll back", "rollback portfolio", "portfolio ko rollback karo"],
            ["Deploy to Netlify", "deploy portfolio to netlify", "portfolio ko netlify pe deploy karo"],
            ["Generate render.yaml", "generate render.yaml for portfolio", "portfolio ke liye render.yaml banao"],
          ],
        },
      },
      {
        id: "multi",
        h2: "Several tasks in one message",
        p: ["Combine tasks with \"and\", \"then\" or a new line. Pasted code is kept exactly as you wrote it. A dash in the Hinglish column means no dedicated Hinglish pattern yet: use the English phrasing, or write it in your own words and the optional AI fallback will interpret it."],
        code: "Create a repo named practice and add index.html with <your pasted code> and deploy it to vercel",
      },
      {
        id: "more",
        h2: "Where to go next",
        p: ["New to deployment? Follow the [step-by-step guide to deploying to Vercel without the CLI](/guides/deploy-to-vercel-without-cli), or read the [FAQ](/faq)."],
      },
    ],
  },

  faq: {
    key: "faq",
    path: "/faq",
    title: "FAQ: Easy DevOps questions answered",
    h1: "Frequently asked questions",
    description:
      "Answers about Easy DevOps: supported platforms, whether it uses AI, how safe it is, Hinglish support, multi-step prompts and deploying without the CLI.",
    lead: "Short, direct answers about what Easy DevOps does, how it uses AI, and how your accounts and data are handled.",
    kind: "page",
    updated: "2026-11-16",
    related: ["features", "commands", "privacy"],
    sections: [],
    faq: FAQ,
  },

  "guides/deploy-to-vercel-without-cli": {
    key: "guides/deploy-to-vercel-without-cli",
    path: "/guides/deploy-to-vercel-without-cli",
    title: "How to create a GitHub repo and deploy to Vercel without the CLI",
    h1: "How to create a GitHub repo and deploy it to Vercel without the CLI",
    description:
      "Step-by-step: create a GitHub repo, add your index.html and deploy it to Vercel from a chat, plus the equivalent git and Vercel CLI commands for comparison.",
    lead: "Normally you would install git and the Vercel CLI, run several commands and debug path or login issues. This guide shows the chat way, and the CLI equivalent so you understand what happens underneath.",
    kind: "article",
    updated: "2026-11-16",
    related: ["commands", "features", "faq"],
    sections: [
      {
        id: "prereq",
        h2: "Before you start",
        ul: [
          "A GitHub account (free)",
          "A Vercel account (the free Hobby plan works for personal projects)",
          "Your HTML, CSS and JavaScript files ready, or a single index.html",
        ],
      },
      {
        id: "chat-way",
        h2: "The chat way (about two minutes)",
        ol: [
          "Open Easy DevOps and sign in with GitHub.",
          "Connect your Vercel account from the Connected Apps panel.",
          "Send one message with all three tasks. Paste your index.html code in the same message.",
          "Wait for the checklist: repo created, file added, Vercel project imported and deployed.",
          "Open the live URL shown at the end of the plan.",
        ],
        code: "Create a repo named my-first-site and add index.html with <your code> and deploy it to vercel",
      },
      {
        id: "cli-way",
        h2: "The CLI way, for comparison",
        p: ["These are the commands you would run on your own machine. Easy DevOps performs the equivalent API calls for you."],
        code: "git init\ngit add .\ngit commit -m \"first commit\"\ngit remote add origin https://github.com/<you>/my-first-site.git\ngit push -u origin main\nnpm i -g vercel\nvercel login\nvercel --prod",
      },
      {
        id: "compare",
        h2: "Chat vs CLI",
        table: {
          head: ["", "Easy DevOps chat", "git + Vercel CLI"],
          rows: [
            ["Install anything", "No", "git, Node.js, Vercel CLI"],
            ["Works from a phone", "Yes", "No"],
            ["Learning curve", "Type what you want", "Learn several commands"],
            ["Confirmation before risky actions", "Built in", "You must be careful"],
          ],
        },
      },
      {
        id: "problems",
        h2: "If something goes wrong",
        ul: [
          "Build failed: the live log highlights the error line and, with an AI key, explains the cause.",
          "Repo already exists: pick a different name or continue with the existing repo.",
          "Vercel not connected: connect it in the Connected Apps panel and send the message again.",
        ],
        p: ["More answers are in the [FAQ](/faq) and the [command cookbook](/commands)."],
      },
    ],
  },

  about: {
    key: "about",
    path: "/about",
    title: "About Easy DevOps and its creator",
    h1: "About Easy DevOps",
    description:
      "Easy DevOps is an independent project by full-stack developer Shiva Saini, built so students can ship projects without learning the CLI first.",
    lead: "Easy DevOps exists because the first deployment is usually the hardest part of learning to build for the web.",
    kind: "about",
    updated: "2026-11-16",
    related: ["features", "how-it-works", "privacy"],
    sections: [
      {
        id: "why",
        h2: "Why it was built",
        p: ["Many students and new developers get stuck before their first deployment: installing git, understanding remotes, logging into CLIs and reading dashboards. Easy DevOps lets them describe what they want in plain language, including Hinglish, and handles the platform work on their own accounts."],
      },
      {
        id: "creator",
        h2: "Who builds it",
        p: ["Easy DevOps is an independent project by Shiva Saini, a full-stack developer who builds and ships web, AI and game projects. You can find more work on [GitHub](https://github.com/Shiva-sainiiii)."],
      },
      {
        id: "principles",
        h2: "Design principles",
        ul: [
          "Rules first, AI only when needed, so common tasks are fast and cost nothing",
          "Always confirm risky actions",
          "You own your accounts and keys; nothing is deployed anywhere you did not connect",
          "Be transparent: every reply shows whether AI was used",
        ],
      },
    ],
  },

  privacy: {
    key: "privacy",
    path: "/privacy",
    title: "Privacy: what Easy DevOps stores and why",
    h1: "Privacy",
    description:
      "What Easy DevOps stores (encrypted provider tokens, AI keys, chat history, usage counts), what it does not, and how to disconnect or revoke access.",
    lead: "Easy DevOps acts on your GitHub, Vercel, Netlify and Render accounts, so it is important to be clear about what is kept. Last updated 16 November 2026.",
    kind: "page",
    updated: "2026-11-16",
    related: ["faq", "how-it-works", "about"],
    sections: [
      {
        id: "stored",
        h2: "What is stored",
        ul: [
          "Basic GitHub profile details: your GitHub id, login name and avatar URL.",
          "Provider tokens (GitHub, Vercel, Netlify, Render) that you connect, encrypted at rest.",
          "AI Gateway keys that you add, encrypted at rest.",
          "Chat history, so your conversations can sync across your devices.",
          "Usage counters: timestamps, request counts, AI provider and model names, status codes and token counts. These do not include your messages or AI replies.",
        ],
      },
      {
        id: "not-stored",
        h2: "What is not stored",
        ul: [
          "No passwords. Sign-in is through GitHub OAuth.",
          "Your AI prompts and replies are not kept in the usage logs.",
          "Pasted code is used only to perform the action you asked for.",
        ],
      },
      {
        id: "permissions",
        h2: "GitHub permissions",
        p: ["GitHub sign-in requests the repo and delete_repo scopes (read and write access to repositories, and the ability to delete them) because Easy DevOps creates, edits and deletes repositories on your behalf. You can disconnect at any time."],
      },
      {
        id: "third",
        h2: "Third parties",
        p: ["Requests you make are sent to the provider you chose, such as GitHub, Vercel, Netlify, Render, Google AI Studio or OpenRouter, using your own tokens and keys. Their own privacy policies apply to data they receive."],
      },
      {
        id: "control",
        h2: "Your control",
        ul: [
          "Log Out disconnects and removes your stored provider tokens and AI keys.",
          "You can revoke the OAuth authorisation in your GitHub settings at any time.",
          "You can revoke tokens directly in Vercel, Netlify and Render.",
        ],
      },
      {
        id: "contact",
        h2: "Questions",
        p: ["For privacy questions or removal requests, contact the creator through the [GitHub profile](https://github.com/Shiva-sainiiii)."],
      },
    ],
  },
};

export const PAGE_ORDER = ["features", "how-it-works", "commands", "faq", "guides/deploy-to-vercel-without-cli", "about", "privacy"];
export const NAV_LINKS: { label: string; path: string }[] = [
  { label: "Features", path: "/features" },
  { label: "How it works", path: "/how-it-works" },
  { label: "Commands", path: "/commands" },
  { label: "FAQ", path: "/faq" },
  { label: "Guide", path: "/guides/deploy-to-vercel-without-cli" },
];
