"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import ReactMarkdown from "react-markdown";
import type {
  ChatSource,
  DocumentRow,
  MessageRow,
} from "@/lib/types";

const LS_CONV = "orange_terminal_conversation_id";

type UploadUi =
  | { state: "idle" }
  | { state: "uploading"; percent: number; determinate: boolean }
  | { state: "processing" };

export function Workspace() {
  const [documents, setDocuments] = useState<DocumentRow[]>([]);
  const [selectedDocId, setSelectedDocId] = useState<string | null>(null);
  const [conversationId, setConversationId] = useState<string | null>(null);
  const [messages, setMessages] = useState<MessageRow[]>([]);
  const [input, setInput] = useState("");
  const [lastSources, setLastSources] = useState<ChatSource[]>([]);
  const [loadingDocs, setLoadingDocs] = useState(true);
  const [sending, setSending] = useState(false);
  const [uploadUi, setUploadUi] = useState<UploadUi>({ state: "idle" });
  const [insightsLoadingId, setInsightsLoadingId] = useState<string | null>(
    null
  );
  const [error, setError] = useState<string | null>(null);

  const selectedDoc = useMemo(
    () => documents.find((d) => d.id === selectedDocId) ?? null,
    [documents, selectedDocId]
  );

  const refreshDocuments = useCallback(async () => {
    setLoadingDocs(true);
    setError(null);
    try {
      const res = await fetch("/api/documents");
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "Failed to load documents");
      setDocuments(data.documents || []);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to load documents");
    } finally {
      setLoadingDocs(false);
    }
  }, []);

  const loadConversation = useCallback(async (id: string) => {
    setError(null);
    try {
      const res = await fetch(`/api/conversations/${id}`);
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "Failed to load chat");
      const msgs = (data.messages || []) as MessageRow[];
      setMessages(msgs);
      const lastAssistant = [...msgs].reverse().find((m) => m.role === "assistant");
      setLastSources(lastAssistant?.sources_json || []);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to load chat");
      localStorage.removeItem(LS_CONV);
      setConversationId(null);
      setMessages([]);
    }
  }, []);

  useEffect(() => {
    void refreshDocuments();
  }, [refreshDocuments]);

  useEffect(() => {
    const saved = localStorage.getItem(LS_CONV);
    if (saved) {
      setConversationId(saved);
      void loadConversation(saved);
    }
  }, [loadConversation]);

  const newChat = () => {
    localStorage.removeItem(LS_CONV);
    setConversationId(null);
    setMessages([]);
    setLastSources([]);
    setError(null);
  };

  const onUpload = (fileList: FileList | null) => {
    const file = fileList?.[0];
    if (!file) return;
    setError(null);
    setUploadUi({ state: "uploading", percent: 0, determinate: false });

    const fd = new FormData();
    fd.append("file", file);

    const xhr = new XMLHttpRequest();
    xhr.open("POST", "/api/documents");

    xhr.upload.onprogress = (e) => {
      if (e.lengthComputable && e.total > 0) {
        setUploadUi({
          state: "uploading",
          percent: Math.min(100, Math.round((e.loaded / e.total) * 100)),
          determinate: true,
        });
      }
    };

    xhr.upload.onloadend = () => {
      setUploadUi((prev) =>
        prev.state === "uploading" ? { state: "processing" } : prev
      );
    };

    xhr.onload = () => {
      void (async () => {
        try {
          let data: { error?: string; document?: { id: string } } = {};
          try {
            data = JSON.parse(xhr.responseText || "{}") as typeof data;
          } catch {
            throw new Error("Invalid response from server");
          }
          if (xhr.status >= 200 && xhr.status < 300) {
            await refreshDocuments();
            if (data.document?.id) setSelectedDocId(data.document.id);
          } else {
            throw new Error(data.error || "Upload failed");
          }
        } catch (e) {
          setError(e instanceof Error ? e.message : "Upload failed");
        } finally {
          setUploadUi({ state: "idle" });
        }
      })();
    };

    xhr.onerror = () => {
      setError("Network error during upload");
      setUploadUi({ state: "idle" });
    };

    xhr.send(fd);
  };

  const sendMessage = async () => {
    const text = input.trim();
    if (!text || sending) return;
    setSending(true);
    setError(null);
    const optimistic: MessageRow = {
      id: `temp-${Date.now()}`,
      role: "user",
      content: text,
      sources_json: null,
      created_at: new Date().toISOString(),
    };
    setMessages((m) => [...m, optimistic]);
    setInput("");
    try {
      const res = await fetch("/api/chat", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          conversationId,
          message: text,
          selectedDocumentId: selectedDocId,
        }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "Chat failed");
      const cid = data.conversationId as string;
      if (cid !== conversationId) {
        setConversationId(cid);
        localStorage.setItem(LS_CONV, cid);
      }
      const sources = (data.reply?.sources || []) as ChatSource[];
      setLastSources(sources);
      const assistant: MessageRow = {
        id: `a-${Date.now()}`,
        role: "assistant",
        content: data.reply?.content || "",
        sources_json: sources,
        created_at: new Date().toISOString(),
      };
      setMessages((m) => [...m, assistant]);
    } catch (e) {
      setMessages((m) => m.filter((x) => x.id !== optimistic.id));
      setError(e instanceof Error ? e.message : "Chat failed");
    } finally {
      setSending(false);
    }
  };

  const regenerateInsights = async () => {
    if (!selectedDocId) return;
    setInsightsLoadingId(selectedDocId);
    setError(null);
    try {
      const res = await fetch(`/api/documents/${selectedDocId}/insights`, {
        method: "POST",
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "Insights failed");
      await refreshDocuments();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Insights failed");
    } finally {
      setInsightsLoadingId(null);
    }
  };

  const deleteDocument = async (id: string) => {
    if (!confirm("Remove this document and its index?")) return;
    setError(null);
    try {
      const res = await fetch(`/api/documents/${id}`, { method: "DELETE" });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "Delete failed");
      if (selectedDocId === id) setSelectedDocId(null);
      await refreshDocuments();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Delete failed");
    }
  };

  return (
    <div className="flex h-[100dvh] flex-col text-[15px] text-zinc-100">
      <header className="flex h-12 shrink-0 items-center border-b border-zinc-800 px-4">
        <span className="text-sm font-semibold tracking-tight text-zinc-100">
          Orange Terminal
        </span>
        <span className="ml-3 text-xs text-zinc-500">
          Value research · RAG on PDFs &amp; Excel — cited answers
        </span>
      </header>

      {error ? (
        <div className="border-b border-red-900/50 bg-red-950/40 px-4 py-2 text-sm text-red-200">
          {error}
        </div>
      ) : null}

      <div className="grid min-h-0 flex-1 grid-cols-[260px_1fr_340px]">
        {/* Documents */}
        <aside className="flex min-h-0 flex-col border-r border-zinc-800 bg-[var(--surface)]">
          <div className="border-b border-zinc-800 p-3">
            <label
              className={`flex cursor-pointer flex-col items-center justify-center rounded-lg border border-dashed border-zinc-600 bg-zinc-900/50 px-3 py-6 text-center text-xs text-zinc-400 transition hover:border-teal-600/50 hover:bg-zinc-900 ${
                uploadUi.state !== "idle" ? "pointer-events-none opacity-90" : ""
              }`}
            >
              <input
                type="file"
                accept=".pdf,.xlsx,.xls,application/pdf,application/vnd.ms-excel,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
                className="hidden"
                disabled={uploadUi.state !== "idle"}
                onChange={(e) => {
                  onUpload(e.target.files);
                  e.target.value = "";
                }}
              />
              {uploadUi.state === "idle" ? (
                "Drop or click to upload"
              ) : uploadUi.state === "uploading" ? (
                <>
                  <span className="font-medium text-zinc-200">
                    {uploadUi.determinate
                      ? `Uploading… ${uploadUi.percent}%`
                      : "Uploading…"}
                  </span>
                  <span className="mt-1 text-[11px] text-zinc-500">
                    Sending file to server
                  </span>
                  <div
                    className="mt-3 h-1.5 w-full max-w-[200px] overflow-hidden rounded-full bg-zinc-800"
                    role="progressbar"
                    aria-valuenow={
                      uploadUi.determinate ? uploadUi.percent : undefined
                    }
                    aria-valuemin={0}
                    aria-valuemax={100}
                  >
                    <div
                      className="h-full rounded-full bg-teal-500 transition-[width] duration-150 ease-out"
                      style={{
                        width: uploadUi.determinate
                          ? `${uploadUi.percent}%`
                          : "40%",
                      }}
                    />
                  </div>
                </>
              ) : (
                <>
                  <span className="font-medium text-zinc-200">
                    Processing…
                  </span>
                  <span className="mt-1 text-[11px] text-zinc-500">
                    Extracting text, embedding, indexing
                  </span>
                  <div className="mt-3 h-1.5 w-full max-w-[200px] overflow-hidden rounded-full bg-zinc-800">
                    <div className="h-full w-full animate-pulse rounded-full bg-teal-500/60" />
                  </div>
                </>
              )}
            </label>
          </div>
          <div className="scroll-thin min-h-0 flex-1 overflow-y-auto p-2">
            {loadingDocs ? (
              <p className="px-2 py-3 text-xs text-zinc-500">Loading…</p>
            ) : documents.length === 0 ? (
              <p className="px-2 py-3 text-xs text-zinc-500">
                No documents yet. Upload a filing or model to begin.
              </p>
            ) : (
              <ul className="space-y-1">
                {documents.map((d) => (
                  <li key={d.id}>
                    <button
                      type="button"
                      onClick={() => setSelectedDocId(d.id)}
                      className={`flex w-full flex-col rounded-md border px-2 py-2 text-left text-xs transition ${
                        selectedDocId === d.id
                          ? "border-teal-600/40 bg-[var(--accent-muted)]"
                          : "border-transparent hover:bg-zinc-800/80"
                      }`}
                    >
                      <span className="truncate font-medium text-zinc-200">
                        {d.file_name}
                      </span>
                      <span className="mt-0.5 font-mono text-[10px] uppercase text-zinc-500">
                        {d.status}
                        {d.status === "failed" && d.error_message
                          ? ` — ${d.error_message.slice(0, 40)}…`
                          : ""}
                      </span>
                    </button>
                  </li>
                ))}
              </ul>
            )}
          </div>
        </aside>

        {/* Chat */}
        <main className="flex min-h-0 flex-col bg-[var(--background)]">
          <div className="flex items-center justify-between border-b border-zinc-800 px-4 py-2">
            <span className="text-xs font-medium text-zinc-500">Research chat</span>
            <button
              type="button"
              onClick={newChat}
              className="rounded-md border border-zinc-700 px-2 py-1 text-xs text-zinc-300 hover:bg-zinc-800"
            >
              New chat
            </button>
          </div>
          <div className="scroll-thin min-h-0 flex-1 space-y-4 overflow-y-auto px-4 py-4">
            {messages.length === 0 ? (
              <div className="mx-auto max-w-xl rounded-xl border border-zinc-800 bg-zinc-900/30 p-6 text-sm text-zinc-400">
                <p className="font-medium text-zinc-200">Ask about your documents</p>
                <p className="mt-2 leading-relaxed">
                  Upload PDFs or Excel files, wait until status is{" "}
                  <span className="font-mono text-teal-400">ready</span>, then ask
                  questions. Answers include sources (file name + excerpt). Use the
                  sidebar to focus on one document, or leave none selected to
                  search across all ready documents.
                </p>
              </div>
            ) : null}
            {messages.map((m) => (
              <div
                key={m.id}
                className={`flex ${m.role === "user" ? "justify-end" : "justify-start"}`}
              >
                <div
                  className={`max-w-[85%] rounded-2xl px-4 py-3 text-sm leading-relaxed ${
                    m.role === "user"
                      ? "bg-teal-900/40 text-zinc-100"
                      : "border border-zinc-800 bg-zinc-900/60 text-zinc-200"
                  }`}
                >
                  {m.role === "assistant" ? (
                    <div className="md-content">
                      <ReactMarkdown>{m.content}</ReactMarkdown>
                    </div>
                  ) : (
                    m.content
                  )}
                </div>
              </div>
            ))}
            {sending ? (
              <div className="flex justify-start">
                <div className="rounded-2xl border border-zinc-800 bg-zinc-900/40 px-4 py-3 text-sm text-zinc-500">
                  Thinking…
                </div>
              </div>
            ) : null}
          </div>
          <div className="border-t border-zinc-800 p-3">
            <div className="mx-auto flex max-w-3xl gap-2">
              <textarea
                value={input}
                onChange={(e) => setInput(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter" && !e.shiftKey) {
                    e.preventDefault();
                    void sendMessage();
                  }
                }}
                rows={2}
                placeholder="Ask a question about your documents…"
                className="min-h-[48px] flex-1 resize-none rounded-xl border border-zinc-700 bg-zinc-900/50 px-3 py-2 text-sm text-zinc-100 placeholder:text-zinc-600 focus:border-teal-600/50 focus:outline-none"
              />
              <button
                type="button"
                disabled={sending || !input.trim()}
                onClick={() => void sendMessage()}
                className="self-end rounded-xl bg-teal-600 px-4 py-2 text-sm font-medium text-zinc-950 hover:bg-teal-500 disabled:opacity-40"
              >
                Send
              </button>
            </div>
          </div>
        </main>

        {/* Sources & insights */}
        <aside className="flex min-h-0 flex-col border-l border-zinc-800 bg-[var(--surface)]">
          <div className="border-b border-zinc-800 px-3 py-2">
            <h2 className="text-xs font-semibold uppercase tracking-wide text-zinc-500">
              Sources
            </h2>
            <p className="mt-1 text-[11px] text-zinc-600">
              From the latest assistant reply
            </p>
          </div>
          <div className="scroll-thin max-h-[38%] min-h-0 overflow-y-auto border-b border-zinc-800 p-3">
            {lastSources.length === 0 ? (
              <p className="text-xs text-zinc-500">
                Sources appear here after each answer.
              </p>
            ) : (
              <ul className="space-y-3">
                {lastSources.map((s, i) => (
                  <li
                    key={`${s.chunkId}-${i}`}
                    className="rounded-lg border border-zinc-800 bg-zinc-900/40 p-2"
                  >
                    <p className="font-mono text-[11px] text-teal-500">
                      {s.fileName}
                    </p>
                    <p className="mt-1 text-xs leading-relaxed text-zinc-400">
                      {s.snippet}
                    </p>
                  </li>
                ))}
              </ul>
            )}
          </div>

          <div className="flex min-h-0 flex-1 flex-col">
            <div className="flex items-center justify-between border-b border-zinc-800 px-3 py-2">
              <h2 className="text-xs font-semibold uppercase tracking-wide text-zinc-500">
                Insights
              </h2>
              {selectedDocId ? (
                <button
                  type="button"
                  disabled={insightsLoadingId === selectedDocId}
                  onClick={() => void regenerateInsights()}
                  className="text-[11px] text-teal-500 hover:underline disabled:opacity-40"
                >
                  {insightsLoadingId === selectedDocId ? "Running…" : "Regenerate"}
                </button>
              ) : null}
            </div>
            <div className="scroll-thin min-h-0 flex-1 overflow-y-auto p-3">
              {!selectedDoc ? (
                <p className="text-xs text-zinc-500">
                  Select a document to view red flags, metrics, and business
                  quality notes.
                </p>
              ) : selectedDoc.status !== "ready" ? (
                <p className="text-xs text-zinc-500">
                  Insights are available when the document is ready.
                </p>
              ) : !selectedDoc.insights_json ? (
                <p className="text-xs text-zinc-500">
                  No insights yet. They generate after indexing; use Regenerate if
                  needed.
                </p>
              ) : (
                <div className="space-y-4 text-xs">
                  <section>
                    <h3 className="font-semibold text-red-400">Red flags</h3>
                    <ul className="mt-1 list-disc space-y-1 pl-4 text-zinc-400">
                      {(selectedDoc.insights_json.redFlags || []).map((r, i) => (
                        <li key={i}>{r}</li>
                      ))}
                    </ul>
                  </section>
                  <section>
                    <h3 className="font-semibold text-zinc-200">Key metrics</h3>
                    <ul className="mt-2 space-y-2">
                      {(selectedDoc.insights_json.keyMetrics || []).map(
                        (k, i) => (
                          <li
                            key={i}
                            className="flex justify-between gap-2 border-b border-zinc-800/80 pb-2 font-mono text-[11px]"
                          >
                            <span className="text-zinc-500">{k.label}</span>
                            <span className="text-right text-teal-400">
                              {k.value}
                            </span>
                          </li>
                        )
                      )}
                    </ul>
                  </section>
                  <section>
                    <h3 className="font-semibold text-zinc-200">
                      Business quality
                    </h3>
                    <p className="mt-1 leading-relaxed text-zinc-400">
                      {selectedDoc.insights_json.businessQualitySummary}
                    </p>
                  </section>
                  <button
                    type="button"
                    onClick={() => void deleteDocument(selectedDoc.id)}
                    className="text-[11px] text-red-400 hover:underline"
                  >
                    Delete document
                  </button>
                </div>
              )}
            </div>
          </div>
        </aside>
      </div>
    </div>
  );
}
