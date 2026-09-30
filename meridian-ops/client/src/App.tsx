import { FormEvent, useEffect, useState } from "react";

type User = { id: number; email: string };
type Ticket = {
  id: number;
  title: string;
  body: string;
  status: string;
  category: string | null;
  priority: string | null;
  summary: string | null;
};
type Doc = { id: number; title: string; content: string };
type Msg = { role: string; content: string };
type Overview = {
  tickets: number;
  open: number;
  p0: number;
  docs: number;
  byCategory: Array<{ category: string; count: number }>;
};

async function api<T>(url: string, init?: RequestInit): Promise<T> {
  const res = await fetch(url, {
    ...init,
    headers: { "Content-Type": "application/json", ...(init?.headers ?? {}) },
  });
  const data = (await res.json()) as T & { error?: string };
  if (!res.ok) throw new Error(data.error || "Request failed");
  return data;
}

const TABS = ["Overview", "Tickets", "Knowledge", "Assistant", "Incident agent"] as const;
type Tab = (typeof TABS)[number];

export function App() {
  const [user, setUser] = useState<User | null | undefined>(undefined);
  const [tab, setTab] = useState<Tab>("Overview");
  const [error, setError] = useState("");

  useEffect(() => {
    api<{ user: User | null }>("/api/me")
      .then((d) => setUser(d.user))
      .catch(() => setUser(null));
  }, []);

  if (user === undefined) return <p className="lead" style={{ padding: 32 }}>Loading…</p>;
  if (!user) {
    return (
      <Auth
        onIn={(u) => setUser(u)}
        error={error}
        setError={setError}
      />
    );
  }

  return (
    <div className="shell">
      <aside className="side">
        <p className="brand">Meridian</p>
        <p className="sub">{user.email}</p>
        <nav className="nav">
          {TABS.map((t) => (
            <button key={t} className={tab === t ? "on" : ""} onClick={() => setTab(t)}>
              {t}
            </button>
          ))}
        </nav>
        <button
          className="ghost"
          style={{ marginTop: 24 }}
          onClick={() => {
            void api("/api/logout", { method: "POST" }).then(() => setUser(null));
          }}
        >
          Sign out
        </button>
      </aside>
      <main className="main">
        {error ? <p className="err">{error}</p> : null}
        {tab === "Overview" && <OverviewView />}
        {tab === "Tickets" && <TicketsView setError={setError} />}
        {tab === "Knowledge" && <KnowledgeView setError={setError} />}
        {tab === "Assistant" && <AssistantView setError={setError} />}
        {tab === "Incident agent" && <AgentView setError={setError} />}
      </main>
    </div>
  );
}

function Auth({
  onIn,
  error,
  setError,
}: {
  onIn: (u: User) => void;
  error: string;
  setError: (s: string) => void;
}) {
  const [mode, setMode] = useState<"login" | "register">("login");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");

  async function submit(e: FormEvent) {
    e.preventDefault();
    setError("");
    try {
      const u = await api<{ email: string }>(mode === "login" ? "/api/login" : "/api/register", {
        method: "POST",
        body: JSON.stringify({ email, password }),
      });
      onIn({ id: 0, email: u.email });
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed");
    }
  }

  return (
    <div className="auth">
      <form className="card" onSubmit={(e) => void submit(e)}>
        <p className="brand">Meridian</p>
        <p className="sub">Internal AI ops desk — React UI, Express APIs, SQLite, Groq.</p>
        <label>Email</label>
        <input value={email} onChange={(e) => setEmail(e.target.value)} type="email" required />
        <label>Password</label>
        <input value={password} onChange={(e) => setPassword(e.target.value)} type="password" minLength={6} required />
        {error ? <p className="err">{error}</p> : null}
        <button className="primary" type="submit">{mode === "login" ? "Sign in" : "Create account"}</button>
        <button
          className="ghost"
          type="button"
          onClick={() => setMode(mode === "login" ? "register" : "login")}
        >
          {mode === "login" ? "Need an account?" : "Have an account?"}
        </button>
      </form>
    </div>
  );
}

function OverviewView() {
  const [data, setData] = useState<Overview | null>(null);
  useEffect(() => {
    void api<Overview>("/api/overview").then(setData);
  }, []);
  return (
    <>
      <h1>Operations pulse</h1>
      <p className="lead">Tickets, runbooks, and AI workflows in one desk.</p>
      <div className="grid">
        {(["tickets", "open", "p0", "docs"] as const).map((k) => (
          <div className="card stat" key={k}>
            <span className="sub">{k}</span>
            <b>{data?.[k] ?? "—"}</b>
          </div>
        ))}
      </div>
      <div className="card">
        {(data?.byCategory ?? []).map((r) => (
          <p key={r.category}>
            {r.category}: <b>{r.count}</b>
          </p>
        ))}
      </div>
    </>
  );
}

function TicketsView({ setError }: { setError: (s: string) => void }) {
  const [rows, setRows] = useState<Ticket[]>([]);
  const [title, setTitle] = useState("");
  const [body, setBody] = useState("");
  const [busy, setBusy] = useState<number | null>(null);
  async function load() {
    setRows(await api<Ticket[]>("/api/tickets"));
  }
  useEffect(() => {
    void load();
  }, []);
  return (
    <>
      <h1>Tickets</h1>
      <p className="lead">File work, then classify and summarize with Groq.</p>
      <form
        className="card"
        onSubmit={(e) => {
          e.preventDefault();
          void api("/api/tickets", { method: "POST", body: JSON.stringify({ title, body }) })
            .then(() => {
              setTitle("");
              setBody("");
              return load();
            })
            .catch((err: Error) => setError(err.message));
        }}
      >
        <input value={title} onChange={(e) => setTitle(e.target.value)} placeholder="Title" />
        <textarea value={body} onChange={(e) => setBody(e.target.value)} placeholder="What happened?" />
        <button className="primary" type="submit">File ticket</button>
      </form>
      {rows.map((t) => (
        <div className="card" key={t.id}>
          <b>
            #{t.id} {t.title}
          </b>
          <p className="lead">{t.body}</p>
          {t.summary ? <p>{t.summary}</p> : null}
          <p className="sub">
            {t.status} {t.priority} {t.category}
          </p>
          <button
            className="secondary"
            disabled={busy === t.id}
            onClick={() => {
              setBusy(t.id);
              void api(`/api/tickets/${t.id}/classify`, { method: "POST" })
                .then(load)
                .catch((err: Error) => setError(err.message))
                .finally(() => setBusy(null));
            }}
          >
            {busy === t.id ? "Classifying…" : "Classify + summarize"}
          </button>
        </div>
      ))}
    </>
  );
}

function KnowledgeView({ setError }: { setError: (s: string) => void }) {
  const [docs, setDocs] = useState<Doc[]>([]);
  const [query, setQuery] = useState("");
  const [answer, setAnswer] = useState("");
  const [title, setTitle] = useState("");
  const [content, setContent] = useState("");
  async function load() {
    setDocs(await api<Doc[]>("/api/docs"));
  }
  useEffect(() => {
    void load();
  }, []);
  return (
    <>
      <h1>Knowledge</h1>
      <p className="lead">RAG: search runbooks, then answer only from retrieved text.</p>
      <div className="card">
        <input value={query} onChange={(e) => setQuery(e.target.value)} placeholder="Delayed withdrawals?" />
        <button
          className="primary"
          onClick={() => {
            void api<{ answer: string; sources: string[] }>("/api/rag", {
              method: "POST",
              body: JSON.stringify({ query }),
            })
              .then((r) => setAnswer(`${r.answer}\n\nSources: ${r.sources.join(" · ")}`))
              .catch((err: Error) => setError(err.message));
          }}
        >
          Ask
        </button>
        {answer ? <p className="msg">{answer}</p> : null}
      </div>
      <form
        className="card"
        onSubmit={(e) => {
          e.preventDefault();
          void api("/api/docs", { method: "POST", body: JSON.stringify({ title, content }) })
            .then(() => {
              setTitle("");
              setContent("");
              return load();
            })
            .catch((err: Error) => setError(err.message));
        }}
      >
        <input value={title} onChange={(e) => setTitle(e.target.value)} placeholder="Runbook title" />
        <textarea value={content} onChange={(e) => setContent(e.target.value)} placeholder="Procedure" />
        <button className="primary" type="submit">Save document</button>
      </form>
      {docs.map((d) => (
        <div className="card" key={d.id}>
          <b>{d.title}</b>
          <p className="lead">{d.content}</p>
        </div>
      ))}
    </>
  );
}

function AssistantView({ setError }: { setError: (s: string) => void }) {
  const [msgs, setMsgs] = useState<Msg[]>([]);
  const [text, setText] = useState("");
  const [tools, setTools] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    void api<Msg[]>("/api/chat").then(setMsgs);
  }, []);
  return (
    <>
      <h1>Assistant</h1>
      <p className="lead">Tool-calling agent: datetime, runbooks, tickets, notes.</p>
      {msgs.map((m, i) => (
        <div className="card msg" key={i}>
          <span className="sub">{m.role}</span>
          <div>{m.content}</div>
        </div>
      ))}
      {tools.length ? <p className="sub">Tools: {tools.join(", ")}</p> : null}
      <form
        className="card"
        onSubmit={(e) => {
          e.preventDefault();
          const content = text.trim();
          if (!content || busy) return;
          setBusy(true);
          setText("");
          void api<{ answer: string; toolsUsed: string[] }>("/api/chat", {
            method: "POST",
            body: JSON.stringify({ content }),
          })
            .then((r) => {
              setTools(r.toolsUsed);
              return api<Msg[]>("/api/chat");
            })
            .then(setMsgs)
            .catch((err: Error) => setError(err.message))
            .finally(() => setBusy(false));
        }}
      >
        <textarea value={text} onChange={(e) => setText(e.target.value)} placeholder="List open tickets" />
        <button className="primary" disabled={busy} type="submit">
          {busy ? "Thinking…" : "Send"}
        </button>
      </form>
    </>
  );
}

function AgentView({ setError }: { setError: (s: string) => void }) {
  const [rows, setRows] = useState<Ticket[]>([]);
  const [id, setId] = useState<number | null>(null);
  const [brief, setBrief] = useState("");
  useEffect(() => {
    void api<Ticket[]>("/api/tickets").then(setRows);
  }, []);
  return (
    <>
      <h1>Incident agent</h1>
      <p className="lead">Multi-step: ticket + runbooks → briefing and user reply.</p>
      {rows.map((t) => (
        <button
          key={t.id}
          className={id === t.id ? "primary" : "secondary"}
          style={{ margin: 4 }}
          onClick={() => setId(t.id)}
        >
          #{t.id} {t.title}
        </button>
      ))}
      <p>
        <button
          className="primary"
          disabled={!id}
          onClick={() => {
            setBrief("Running…");
            void api<{ briefing: string; sources: string[] }>("/api/agent", {
              method: "POST",
              body: JSON.stringify({ ticketId: id }),
            })
              .then((r) => setBrief(`${r.briefing}\n\nRunbooks: ${r.sources.join(" · ")}`))
              .catch((err: Error) => setError(err.message));
          }}
        >
          Run incident agent
        </button>
      </p>
      {brief ? <div className="card msg">{brief}</div> : null}
    </>
  );
}
