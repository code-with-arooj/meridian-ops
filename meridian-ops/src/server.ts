import "dotenv/config";
import express from "express";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  createSession,
  createUser,
  db,
  destroySession,
  findUserByEmail,
  seedIfNeeded,
  userFromToken,
  verifyPassword,
} from "./db";
import { chatWithTools, complete, searchDocs } from "./ai";

const app = express();
const PORT = 3001;
app.use(express.json());

function readCookie(req: express.Request, name: string) {
  const raw = req.headers.cookie ?? "";
  const part = raw.split(";").map((x) => x.trim()).find((x) => x.startsWith(name + "="));
  return part ? decodeURIComponent(part.slice(name.length + 1)) : undefined;
}

function setSession(res: express.Response, token: string) {
  res.setHeader(
    "Set-Cookie",
    `meridian_session=${token}; HttpOnly; Path=/; SameSite=Lax; Max-Age=${7 * 24 * 60 * 60}`,
  );
}

function auth(req: express.Request, res: express.Response, next: express.NextFunction) {
  const user = userFromToken(readCookie(req, "meridian_session"));
  if (!user) return res.status(401).json({ error: "Please sign in" });
  seedIfNeeded(user.id);
  (req as express.Request & { user: { id: number; email: string } }).user = user;
  next();
}

app.post("/api/register", (req, res) => {
  const email = String(req.body.email ?? "").trim();
  const password = String(req.body.password ?? "");
  if (!email.includes("@") || password.length < 6) {
    return res.status(400).json({ error: "Valid email and password (6+ chars) required" });
  }
  try {
    const user = createUser(email, password);
    const token = createSession(user.id);
    setSession(res, token);
    seedIfNeeded(user.id);
    res.json({ email: user.email });
  } catch {
    res.status(400).json({ error: "Email already registered" });
  }
});

app.post("/api/login", (req, res) => {
  const email = String(req.body.email ?? "").trim();
  const password = String(req.body.password ?? "");
  const row = findUserByEmail(email);
  if (!row || !verifyPassword(password, row.password_hash, row.salt)) {
    return res.status(401).json({ error: "Invalid email or password" });
  }
  const token = createSession(row.id);
  setSession(res, token);
  seedIfNeeded(row.id);
  res.json({ email: row.email });
});

app.post("/api/logout", (req, res) => {
  const token = readCookie(req, "meridian_session");
  if (token) destroySession(token);
  res.setHeader("Set-Cookie", "meridian_session=; HttpOnly; Path=/; Max-Age=0");
  res.json({ ok: true });
});

app.get("/api/me", (req, res) => {
  const user = userFromToken(readCookie(req, "meridian_session"));
  if (!user) return res.json({ user: null });
  seedIfNeeded(user.id);
  res.json({ user });
});

app.get("/api/overview", auth, (req, res) => {
  const userId = (req as typeof req & { user: { id: number } }).user.id;
  const tickets = db.prepare("SELECT COUNT(*) AS c FROM tickets WHERE user_id = ?").get(userId) as { c: number };
  const open = db
    .prepare("SELECT COUNT(*) AS c FROM tickets WHERE user_id = ? AND status != 'resolved'")
    .get(userId) as { c: number };
  const p0 = db
    .prepare("SELECT COUNT(*) AS c FROM tickets WHERE user_id = ? AND priority = 'p0'")
    .get(userId) as { c: number };
  const docs = db.prepare("SELECT COUNT(*) AS c FROM docs WHERE user_id = ?").get(userId) as { c: number };
  const byCategory = db
    .prepare(
      "SELECT COALESCE(category,'unlabeled') AS category, COUNT(*) AS count FROM tickets WHERE user_id = ? GROUP BY 1",
    )
    .all(userId);
  res.json({ tickets: tickets.c, open: open.c, p0: p0.c, docs: docs.c, byCategory });
});

app.get("/api/tickets", auth, (req, res) => {
  const userId = (req as typeof req & { user: { id: number } }).user.id;
  res.json(
    db
      .prepare("SELECT * FROM tickets WHERE user_id = ? ORDER BY id DESC")
      .all(userId),
  );
});

app.post("/api/tickets", auth, (req, res) => {
  const userId = (req as typeof req & { user: { id: number } }).user.id;
  const title = String(req.body.title ?? "").trim();
  const body = String(req.body.body ?? "").trim();
  if (!title || !body) return res.status(400).json({ error: "Title and details required" });
  const result = db
    .prepare("INSERT INTO tickets (user_id, title, body) VALUES (?, ?, ?)")
    .run(userId, title, body);
  res.json({ id: Number(result.lastInsertRowid) });
});

app.post("/api/tickets/:id/classify", auth, async (req, res) => {
  try {
    const userId = (req as typeof req & { user: { id: number } }).user.id;
    const id = Number(req.params.id);
    const t = db
      .prepare("SELECT * FROM tickets WHERE id = ? AND user_id = ?")
      .get(id, userId) as { title: string; body: string } | undefined;
    if (!t) return res.status(404).json({ error: "Ticket not found" });
    const raw = await complete(
      'Classify. JSON only: {"category":"kyc|security|trading|billing|infra|other","priority":"p0|p1|p2|p3","summary":"one sentence"}',
      `Title: ${t.title}\n\n${t.body}`,
      250,
    );
    let parsed = { category: "other", priority: "p2", summary: raw };
    try {
      parsed = JSON.parse(raw.replace(/```json|```/g, "").trim());
    } catch {
      /* keep */
    }
    db.prepare(
      "UPDATE tickets SET category = ?, priority = ?, summary = ? WHERE id = ? AND user_id = ?",
    ).run(parsed.category, parsed.priority, parsed.summary, id, userId);
    res.json(parsed);
  } catch (err) {
    res.status(500).json({ error: err instanceof Error ? err.message : "AI failed" });
  }
});

app.get("/api/docs", auth, (req, res) => {
  const userId = (req as typeof req & { user: { id: number } }).user.id;
  res.json(db.prepare("SELECT * FROM docs WHERE user_id = ? ORDER BY id DESC").all(userId));
});

app.post("/api/docs", auth, (req, res) => {
  const userId = (req as typeof req & { user: { id: number } }).user.id;
  const title = String(req.body.title ?? "").trim();
  const content = String(req.body.content ?? "").trim();
  if (!title || !content) return res.status(400).json({ error: "Title and content required" });
  db.prepare("INSERT INTO docs (user_id, title, content) VALUES (?, ?, ?)").run(userId, title, content);
  res.json({ ok: true });
});

app.post("/api/rag", auth, async (req, res) => {
  try {
    const userId = (req as typeof req & { user: { id: number } }).user.id;
    const query = String(req.body.query ?? "").trim();
    const hits = searchDocs(userId, query);
    const answer = await complete(
      "Answer using only the knowledge excerpts. If missing, say you do not have that procedure.",
      `Question: ${query}\n\n${hits.map((h) => `### ${h.title}\n${h.content}`).join("\n\n")}`,
    );
    res.json({ answer, sources: hits.map((h) => h.title) });
  } catch (err) {
    res.status(500).json({ error: err instanceof Error ? err.message : "AI failed" });
  }
});

app.get("/api/chat", auth, (req, res) => {
  const userId = (req as typeof req & { user: { id: number } }).user.id;
  res.json(
    db
      .prepare("SELECT role, content FROM messages WHERE user_id = ? ORDER BY id ASC LIMIT 40")
      .all(userId),
  );
});

app.post("/api/chat", auth, async (req, res) => {
  try {
    const userId = (req as typeof req & { user: { id: number } }).user.id;
    const content = String(req.body.content ?? "").trim();
    if (!content) return res.status(400).json({ error: "Message required" });
    db.prepare("INSERT INTO messages (user_id, role, content) VALUES (?, 'user', ?)").run(userId, content);
    const history = db
      .prepare("SELECT role, content FROM messages WHERE user_id = ? ORDER BY id DESC LIMIT 16")
      .all(userId) as Array<{ role: string; content: string }>;
    const result = await chatWithTools(userId, history.slice().reverse());
    db.prepare("INSERT INTO messages (user_id, role, content) VALUES (?, 'assistant', ?)").run(
      userId,
      result.answer,
    );
    res.json(result);
  } catch (err) {
    res.status(500).json({ error: err instanceof Error ? err.message : "AI failed" });
  }
});

app.post("/api/agent", auth, async (req, res) => {
  try {
    const userId = (req as typeof req & { user: { id: number } }).user.id;
    const id = Number(req.body.ticketId);
    const t = db
      .prepare("SELECT * FROM tickets WHERE id = ? AND user_id = ?")
      .get(id, userId) as { title: string; body: string } | undefined;
    if (!t) return res.status(404).json({ error: "Ticket not found" });
    const docs = searchDocs(userId, `${t.title} ${t.body}`);
    const briefing = await complete(
      "Write: Situation, Likely cause, Runbook match, Immediate actions, User-facing reply. Use only this context.",
      `Ticket: ${t.title}\n${t.body}\n\nRunbooks:\n${docs.map((d) => `${d.title}: ${d.content}`).join("\n\n")}`,
      700,
    );
    res.json({ briefing, sources: docs.map((d) => d.title) });
  } catch (err) {
    res.status(500).json({ error: err instanceof Error ? err.message : "AI failed" });
  }
});

const clientDir = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "client");
app.use(express.static(clientDir));

app.listen(PORT, () => {
  console.log(`API ready on http://localhost:${PORT}`);
  console.log(`UI: run npm run dev and open http://localhost:5173`);
  if (!process.env.GROQ_API_KEY) console.log("WARNING: GROQ_API_KEY missing in .env");
});
