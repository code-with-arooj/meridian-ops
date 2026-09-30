import Groq from "groq-sdk";
import { db } from "./db";

const MODEL = "openai/gpt-oss-20b";

export function groq() {
  const key = process.env.GROQ_API_KEY;
  if (!key) throw new Error("GROQ_API_KEY missing. Copy .env.example to .env");
  return new Groq({ apiKey: key });
}

export async function complete(system: string, user: string, maxTokens = 500) {
  const res = await groq().chat.completions.create({
    model: MODEL,
    max_tokens: maxTokens,
    messages: [
      { role: "system", content: system },
      { role: "user", content: user },
    ],
  });
  return res.choices[0]?.message?.content ?? "";
}

type ToolCall = {
  id: string;
  function: { name: string; arguments: string };
};

const tools = [
  {
    type: "function" as const,
    function: {
      name: "get_current_datetime",
      description: "Current date/time in UTC and Asia/Karachi",
      parameters: { type: "object", properties: {} },
    },
  },
  {
    type: "function" as const,
    function: {
      name: "search_knowledge",
      description: "Search internal runbooks",
      parameters: {
        type: "object",
        properties: { query: { type: "string" } },
        required: ["query"],
      },
    },
  },
  {
    type: "function" as const,
    function: {
      name: "list_open_tickets",
      description: "List open tickets",
      parameters: { type: "object", properties: {} },
    },
  },
  {
    type: "function" as const,
    function: {
      name: "save_note",
      description: "Save an ops note",
      parameters: {
        type: "object",
        properties: { title: { type: "string" }, content: { type: "string" } },
        required: ["title", "content"],
      },
    },
  },
];

function runTool(userId: number, name: string, argsJson: string) {
  let args: Record<string, string> = {};
  try {
    args = JSON.parse(argsJson || "{}");
  } catch {
    args = {};
  }
  if (name === "get_current_datetime") {
    const now = new Date();
    return `UTC: ${now.toISOString()}\nKarachi: ${now.toLocaleString("en-PK", { timeZone: "Asia/Karachi" })}`;
  }
  if (name === "search_knowledge") {
    const q = `%${args.query ?? ""}%`;
    const rows = db
      .prepare(
        "SELECT title, content FROM docs WHERE user_id = ? AND (title LIKE ? OR content LIKE ?) LIMIT 5",
      )
      .all(userId, q, q) as Array<{ title: string; content: string }>;
    if (!rows.length) return "No matching runbooks.";
    return rows.map((r) => `${r.title}: ${r.content}`).join("\n\n");
  }
  if (name === "list_open_tickets") {
    const rows = db
      .prepare(
        "SELECT id, title, status, priority, category FROM tickets WHERE user_id = ? AND status != 'resolved'",
      )
      .all(userId) as Array<{
      id: number;
      title: string;
      status: string;
      priority: string | null;
      category: string | null;
    }>;
    if (!rows.length) return "No open tickets.";
    return rows
      .map((t) => `#${t.id} [${t.priority ?? "?"}/${t.category ?? "?"}] ${t.title} (${t.status})`)
      .join("\n");
  }
  if (name === "save_note") {
    db.prepare("INSERT INTO notes (user_id, title, content) VALUES (?, ?, ?)").run(
      userId,
      args.title ?? "Note",
      args.content ?? "",
    );
    return `Saved note "${args.title}"`;
  }
  return `Unknown tool ${name}`;
}

export async function chatWithTools(userId: number, history: Array<{ role: string; content: string }>) {
  const messages: Array<Record<string, unknown>> = [
    {
      role: "system",
      content:
        "You are Meridian, an internal ops assistant for Helix Exchange. Use tools when they help. Never invent policy that is not in the runbooks.",
    },
    ...history,
  ];
  const used: string[] = [];
  let answer = "";
  for (let i = 0; i < 4; i += 1) {
    const res = await groq().chat.completions.create({
      model: MODEL,
      max_tokens: 600,
      messages: messages as never,
      tools,
    });
    const msg = res.choices[0]?.message;
    const calls = (msg?.tool_calls ?? []) as ToolCall[];
    if (!calls.length) {
      answer = msg?.content ?? "";
      break;
    }
    messages.push({ role: "assistant", content: msg?.content ?? "", tool_calls: calls });
    for (const call of calls) {
      used.push(call.function.name);
      const result = runTool(userId, call.function.name, call.function.arguments);
      messages.push({ role: "tool", tool_call_id: call.id, content: result });
    }
  }
  return { answer: answer || "I could not complete that request.", toolsUsed: used };
}

export function searchDocs(userId: number, query: string) {
  const q = `%${query}%`;
  const matched = db
    .prepare(
      "SELECT id, title, content FROM docs WHERE user_id = ? AND (title LIKE ? OR content LIKE ?) LIMIT 5",
    )
    .all(userId, q, q) as Array<{ id: number; title: string; content: string }>;
  if (matched.length) return matched;
  return db
    .prepare("SELECT id, title, content FROM docs WHERE user_id = ? ORDER BY id DESC LIMIT 3")
    .all(userId) as Array<{ id: number; title: string; content: string }>;
}
