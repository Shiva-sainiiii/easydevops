import { test } from "node:test";
import assert from "node:assert/strict";
import { classifyMessage, extractBlocks, fillBlocks, splitClauses, validatePlanSteps } from "../lib/commands/chain";

const HTML = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <title>Tic Tac Toe - Team DevOps</title>
  <link rel="stylesheet" href="styles.css">
</head>
<body>
  <div class="container">
    <p class="footer">Made by Shiva, Mohit, Aatish & Yogit</p>
  </div>
  <script src="script.js"></script>
</body>
</html>`;

const cmds = (c: any) => c.steps.map((s: any) => s.cmd);

test("user ka asli 3-kaam wala prompt: repo + index.html(code) — ek hi baar me, 0 AI", () => {
  const c = classifyMessage(`Create a repo name "practice" and add a index.html file with ${HTML}`);
  assert.equal(c.kind, "chain");
  if (c.kind !== "chain") return;
  assert.deepEqual(cmds(c), ["CREATE_REPO", "CREATE_FILE"]);
  assert.equal(c.steps[0].params.repo, "practice");
  assert.equal(c.steps[1].params.repo, "practice");
  assert.equal(c.steps[1].params.path, "index.html");
  assert.equal(c.steps[1].instruction, undefined); // AI content nahi
  const filled = fillBlocks(c.steps[1].params, c.blocks);
  assert.equal(filled.content.trim(), HTML.trim()); // code bilkul same
});

test("create + file + deploy: naye repo pe Vercel import apne aap beech me aata hai", () => {
  const c = classifyMessage(`Create a repo named practice and add index.html with ${HTML} and deploy it to vercel`);
  assert.equal(c.kind, "chain");
  if (c.kind !== "chain") return;
  assert.deepEqual(cmds(c), ["CREATE_REPO", "CREATE_FILE", "VERCEL_IMPORT_REPO", "VERCEL_DEPLOY"]);
  assert.equal(c.steps[3].params.project_name, "practice");
});

test("Hinglish: repo bna de, phir file, phir deploy", () => {
  const c = classifyMessage(`Bhai ek repo bna de "practice" naam se aur practice wali repo me index.html file me ${HTML} daal de phir isko deploy kar do`);
  assert.equal(c.kind, "chain");
  if (c.kind !== "chain") return;
  assert.deepEqual(cmds(c), ["CREATE_REPO", "CREATE_FILE", "VERCEL_IMPORT_REPO", "VERCEL_DEPLOY"]);
});

test("newline + numbered list", () => {
  const c = classifyMessage(`1. create repo shop\n2. add index.html with\n${HTML}\n3. deploy to vercel`);
  assert.equal(c.kind, "chain");
  if (c.kind !== "chain") return;
  assert.deepEqual(cmds(c), ["CREATE_REPO", "CREATE_FILE", "VERCEL_IMPORT_REPO", "VERCEL_DEPLOY"]);
});

test("fenced code block bhi chalta hai", () => {
  const c = classifyMessage("create repo demo and create file app.py with ```python\nprint('hi')\n```");
  assert.equal(c.kind, "chain");
  if (c.kind !== "chain") return;
  assert.equal(c.steps[1].params.path, "app.py");
  assert.equal(fillBlocks(c.steps[1].params, c.blocks).content.trim(), "print('hi')");
});

test("do files, do blocks", () => {
  const c = classifyMessage("create repo duo and add index.html with ```<h1>a</h1>``` and add style.css with ```h1{color:red}```");
  assert.equal(c.kind, "chain");
  if (c.kind !== "chain") return;
  assert.deepEqual(cmds(c), ["CREATE_REPO", "CREATE_FILE", "CREATE_FILE"]);
  assert.deepEqual(c.steps.map((s) => s.params.path), [undefined, "index.html", "style.css"]);
});

test("sirf file+code (repo pehle se hai): single clause, AI nahi", () => {
  const c = classifyMessage(`Practice wali repo me index.html file me ${HTML}. Ye code daal de`);
  assert.equal(c.kind, "chain");
  if (c.kind !== "chain") return;
  assert.deepEqual(cmds(c), ["CREATE_FILE"]);
  assert.equal(c.steps[0].params.repo, "Practice");
});

test("simple commands ab bhi seedha 'single' (regex, 0 AI)", () => {
  for (const msg of ["list repos", "create repo test-xyz", "delete repo test-xyz", "deploy my-app to vercel", "Bhai ek repo bna de practice naam se", "create file README.md in practice"]) {
    const c = classifyMessage(msg);
    assert.equal(c.kind, "single", msg);
  }
});

test("'invite a and b to repo' ek hi kaam rehta hai (and ke baad verb nahi)", () => {
  assert.equal(splitClauses("invite bob and alice to practice").length, 1);
});

test("partial match: bahut extra text -> needs_ai (pehle ek command chala deta tha)", () => {
  const c = classifyMessage("show me my repos and tell me which one is the biggest and oldest one please");
  assert.notEqual(c.kind, "single");
});

test("samajh na aaye to unresolved clause pakda jata hai (AI planner ya user se poochho)", () => {
  const c = classifyMessage("create repo shop and make it awesome with magic");
  assert.equal(c.kind, "needs_ai");
});

test("README.md ka casing bacha rehta hai", () => {
  const c = classifyMessage("create repo docs and add README.md with ```# Hello```");
  assert.equal(c.kind, "chain");
  if (c.kind !== "chain") return;
  assert.equal(c.steps[1].params.path, "README.md");
});

test("extractBlocks: bina fence ka code run bhi pakda jata hai", () => {
  const code = "function a() {\n  return 1;\n}\nconst b = 2;\nlet c = 3;";
  const { text, blocks } = extractBlocks(`create file x.js in demo with\n${code}`);
  assert.equal(blocks.length, 1);
  assert.ok(text.includes("{{BLOCK_1}}"));
});

test("validatePlanSteps: unknown command / galat repo / AI ka likha content reject", () => {
  assert.ok(validatePlanSteps([{ cmd: "RM_RF", params: {} }], 0).error);
  assert.ok(validatePlanSteps([{ cmd: "CREATE_REPO", params: { repo: "a/b" } }], 0).error);
  const ok = validatePlanSteps(
    [{ cmd: "CREATE_REPO", params: { repo: "x" } }, { cmd: "CREATE_FILE", params: { repo: "x", path: "a.html", content: "<script>evil()</script>" }, instruction: "simple page" }],
    0
  );
  assert.equal(ok.error, undefined);
  assert.equal(ok.steps[1].params.content, undefined); // AI content drop
  assert.equal(ok.steps[1].instruction, "simple page");
  assert.equal(validatePlanSteps(Array.from({ length: 9 }, () => ({ cmd: "LIST_REPOS", params: {} })), 0).error, "max 8 steps allowed");
});
