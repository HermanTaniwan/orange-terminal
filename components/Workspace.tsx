"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import ReactMarkdown from "react-markdown";
import type {
  ChatSource,
  ConversationRow,
  DocumentRow,
  MessageRow,
  ProjectRow,
} from "@/lib/types";

const LS_PROJECT = "orange_terminal_project_id";
const LS_CONV_PREFIX = "orange_terminal_conversation_";
/** Matches migration default project; server rejects DELETE for this id. */
const DEFAULT_PROJECT_ID = "00000000-0000-0000-0000-000000000001";

type UploadUi =
  | { state: "idle" }
  | { state: "uploading"; percent: number; determinate: boolean }
  | { state: "processing" };

type ProjectType = "emiten" | "non_emiten";
type ProjectFormMode = "create" | "edit" | null;
type ProjectDraft = {
  name: string;
  description: string;
  projectType: ProjectType;
  tickerSymbol: string;
  exchange: string;
  industryTopic: string;
};

export function Workspace() {
  const [projects, setProjects] = useState<ProjectRow[]>([]);
  const [selectedProjectId, setSelectedProjectId] = useState<string | null>(null);
  const [conversations, setConversations] = useState<ConversationRow[]>([]);
  const [documents, setDocuments] = useState<DocumentRow[]>([]);
  const [focusedDocId, setFocusedDocId] = useState<string | null>(null);
  const [selectedDocIds, setSelectedDocIds] = useState<string[]>([]);
  const [conversationId, setConversationId] = useState<string | null>(null);
  const [messages, setMessages] = useState<MessageRow[]>([]);
  const [input, setInput] = useState("");
  const [lastSources, setLastSources] = useState<ChatSource[]>([]);
  const [loadingDocs, setLoadingDocs] = useState(true);
  const [sending, setSending] = useState(false);
  const [uploadUi, setUploadUi] = useState<UploadUi>({ state: "idle" });
  const [insightsLoadingId, setInsightsLoadingId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [projectFormMode, setProjectFormMode] = useState<ProjectFormMode>(null);
  const [reingestLoading, setReingestLoading] = useState(false);
  const [backfillIdxNamesLoading, setBackfillIdxNamesLoading] = useState(false);
  const [projectDraft, setProjectDraft] = useState<ProjectDraft>({
    name: "",
    description: "",
    projectType: "non_emiten",
    tickerSymbol: "",
    exchange: "IDX",
    industryTopic: "",
  });

  const formatUploadedAt = (iso: string) => {
    const d = new Date(iso);
    if (Number.isNaN(d.getTime())) return iso;
    const datePart = d.toLocaleDateString("id-ID", {
      year: "numeric",
      month: "short",
      day: "2-digit",
    });
    const timePart = d.toLocaleTimeString("id-ID", {
      hour: "2-digit",
      minute: "2-digit",
      hour12: false,
    });
    return `${datePart} ${timePart}`;
  };

  const selectedDoc = useMemo(() => {
    if (!focusedDocId) return null;
    return documents.find((d) => d.id === focusedDocId) ?? null;
  }, [documents, focusedDocId]);

  const selectedProject = useMemo(() => {
    if (!selectedProjectId) return null;
    return projects.find((p) => p.id === selectedProjectId) ?? null;
  }, [projects, selectedProjectId]);

  const emitenIngestStage = useMemo(() => {
    if (!selectedProject || selectedProject.project_type !== "emiten") return "";
    const metrics = (selectedProject.ingest_metrics || {}) as Record<string, unknown>;
    const stage = typeof metrics.stage === "string" ? metrics.stage : "";
    const processed =
      typeof metrics.processedCandidates === "number" ? metrics.processedCandidates : null;
    const total = typeof metrics.totalCandidates === "number" ? metrics.totalCandidates : null;
    if (processed !== null && total !== null && total > 0) {
      return `${stage || "Sedang memproses"} (${processed}/${total})`;
    }
    return stage;
  }, [selectedProject]);

  const emitenIngestDetails = useMemo(() => {
    const metrics = (selectedProject?.ingest_metrics || {}) as Record<string, unknown>;
    return {
      downloadingFile:
        typeof metrics.downloadingFile === "string" ? metrics.downloadingFile : "",
      embeddingFile: typeof metrics.embeddingFile === "string" ? metrics.embeddingFile : "",
      duplicateReadyCount:
        typeof metrics.duplicateReadyCount === "number" ? metrics.duplicateReadyCount : 0,
      skipNoFileCount:
        typeof metrics.skipNoFileCount === "number" ? metrics.skipNoFileCount : 0,
      skipDuplicateProjectCount:
        typeof metrics.skipDuplicateProjectCount === "number"
          ? metrics.skipDuplicateProjectCount
          : 0,
      skipUnsupportedCount:
        typeof metrics.skipUnsupportedCount === "number" ? metrics.skipUnsupportedCount : 0,
      skippedCount: typeof metrics.skippedCount === "number" ? metrics.skippedCount : 0,
    };
  }, [selectedProject]);

  const conversationStorageKey = useMemo(() => {
    if (!selectedProjectId) return null;
    return `${LS_CONV_PREFIX}${selectedProjectId}`;
  }, [selectedProjectId]);

  const refreshProjects = useCallback(async (opts?: { silent?: boolean }) => {
    const silent = opts?.silent === true;
    try {
      const res = await fetch("/api/projects");
      const data = (await res.json().catch(() => ({}))) as { error?: string; projects?: unknown };
      if (!res.ok) {
        throw new Error(data.error || "Failed to load projects");
      }
      const next = (data.projects || []) as ProjectRow[];
      setProjects((prev) => {
        const same =
          prev.length === next.length &&
          prev.every((p, i) => {
            const n = next[i];
            return (
              p.id === n.id &&
              p.name === n.name &&
              p.project_type === n.project_type &&
              p.ticker_symbol === n.ticker_symbol &&
              p.ingest_status === n.ingest_status &&
              p.ingest_updated_at === n.ingest_updated_at
            );
          });
        return same ? prev : next;
      });
      return next;
    } catch (e) {
      if (!silent) {
        setError(e instanceof Error ? e.message : "Failed to load projects");
      }
      return null;
    }
  }, []);

  const refreshConversations = useCallback(async () => {
    if (!selectedProjectId) return;
    try {
      const res = await fetch(`/api/conversations?projectId=${selectedProjectId}`);
      const data = (await res.json().catch(() => ({}))) as {
        error?: string;
        conversations?: unknown;
      };
      if (!res.ok) throw new Error(data.error || "Failed to load conversations");
      setConversations((data.conversations || []) as ConversationRow[]);
    } catch {
      /* avoid unhandled rejection when dev server restarts or network drops */
    }
  }, [selectedProjectId]);

  const refreshDocuments = useCallback(async (opts?: { silent?: boolean }) => {
    if (!selectedProjectId) return;
    const silent = opts?.silent === true;
    if (!silent) {
      setLoadingDocs(true);
      setError(null);
    }
    try {
      const res = await fetch(`/api/documents?projectId=${selectedProjectId}`);
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "Failed to load documents");
      const next = (data.documents || []) as DocumentRow[];
      setDocuments((prev) => {
        const same =
          prev.length === next.length &&
          prev.every((d, i) => {
            const n = next[i];
            const dInsights = d.insights_json ? JSON.stringify(d.insights_json) : "";
            const nInsights = n.insights_json ? JSON.stringify(n.insights_json) : "";
            return (
              d.id === n.id &&
              d.status === n.status &&
              d.file_name === n.file_name &&
              d.created_at === n.created_at &&
              d.error_message === n.error_message &&
              d.char_count === n.char_count &&
              dInsights === nInsights
            );
          });
        return same ? prev : next;
      });
    } catch (e) {
      if (!silent) setError(e instanceof Error ? e.message : "Failed to load documents");
    } finally {
      if (!silent) setLoadingDocs(false);
    }
  }, [selectedProjectId]);

  useEffect(() => {
    if (!selectedProject || selectedProject.project_type !== "emiten") return;
    const t = setInterval(() => {
      void refreshProjects({ silent: true });
      void refreshDocuments({ silent: true });
    }, 10000);
    return () => clearInterval(t);
  }, [selectedProject?.id, selectedProject?.project_type, refreshProjects, refreshDocuments]);

  const loadConversation = useCallback(
    async (id: string) => {
      if (!selectedProjectId) return;
      setError(null);
      try {
        const res = await fetch(
          `/api/conversations/${id}?projectId=${selectedProjectId}`
        );
        const data = await res.json();
        if (!res.ok) throw new Error(data.error || "Failed to load chat");
        const msgs = (data.messages || []) as MessageRow[];
        setMessages(msgs);
        const lastAssistant = [...msgs]
          .reverse()
          .find((m) => m.role === "assistant");
        setLastSources(lastAssistant?.sources_json || []);
      } catch (e) {
        setError(e instanceof Error ? e.message : "Failed to load chat");
        if (conversationStorageKey) localStorage.removeItem(conversationStorageKey);
        setConversationId(null);
        setMessages([]);
      }
    },
    [conversationStorageKey, selectedProjectId]
  );

  useEffect(() => {
    void (async () => {
      try {
        const rows = await refreshProjects();
        if (rows === null) return;
        if (rows.length === 0) {
          const createRes = await fetch("/api/projects", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              name: "Default Project",
              projectType: "non_emiten",
              industryTopic: "General",
            }),
          });
          const createData = await createRes.json();
          if (!createRes.ok) {
            throw new Error(createData.error || "Failed to create project");
          }
          const project = createData.project as ProjectRow;
          setProjects([project]);
          setSelectedProjectId(project.id);
          localStorage.setItem(LS_PROJECT, project.id);
          return;
        }
        const saved = localStorage.getItem(LS_PROJECT);
        const resolved = rows.find((p) => p.id === saved)?.id || rows[0].id;
        setSelectedProjectId(resolved);
      } catch (e) {
        setError(e instanceof Error ? e.message : "Failed to load projects");
      }
    })();
  }, [refreshProjects]);

  useEffect(() => {
    if (!selectedProjectId) return;
    localStorage.setItem(LS_PROJECT, selectedProjectId);
    setConversationId(null);
    setMessages([]);
    setLastSources([]);
    setFocusedDocId(null);
    setSelectedDocIds([]);
    void refreshDocuments();
    void refreshConversations();
    const key = `${LS_CONV_PREFIX}${selectedProjectId}`;
    const savedConv = localStorage.getItem(key);
    if (savedConv) {
      setConversationId(savedConv);
      void loadConversation(savedConv);
    }
  }, [selectedProjectId, refreshDocuments, refreshConversations, loadConversation]);

  useEffect(() => {
    setSelectedDocIds((prev) => prev.filter((id) => documents.some((d) => d.id === id)));
    setFocusedDocId((prev) => (prev && documents.some((d) => d.id === prev) ? prev : null));
  }, [documents]);

  const openCreateProjectForm = () => {
    setProjectDraft({
      name: "",
      description: "",
      projectType: "non_emiten",
      tickerSymbol: "",
      exchange: "IDX",
      industryTopic: "",
    });
    setProjectFormMode("create");
  };

  const openEditProjectForm = () => {
    if (!selectedProject) return;
    setProjectDraft({
      name: selectedProject.name || "",
      description: selectedProject.description || "",
      projectType: selectedProject.project_type || "non_emiten",
      tickerSymbol: selectedProject.ticker_symbol || "",
      exchange: selectedProject.exchange || "IDX",
      industryTopic: selectedProject.industry_topic || "",
    });
    setProjectFormMode("edit");
  };

  const submitProjectForm = async () => {
    const payload = {
      name: projectDraft.name.trim(),
      description: projectDraft.description.trim() || null,
      projectType: projectDraft.projectType,
      tickerSymbol:
        projectDraft.projectType === "emiten"
          ? projectDraft.tickerSymbol.trim().toUpperCase()
          : null,
      exchange:
        projectDraft.projectType === "emiten"
          ? projectDraft.exchange.trim().toUpperCase() || "IDX"
          : null,
      industryTopic:
        projectDraft.projectType === "non_emiten"
          ? projectDraft.industryTopic.trim()
          : null,
    };

    if (!payload.name) {
      setError("Nama project wajib diisi.");
      return;
    }
    if (payload.projectType === "emiten" && !payload.tickerSymbol) {
      setError("Kode emiten wajib diisi untuk project Emiten.");
      return;
    }
    if (payload.projectType === "non_emiten" && !payload.industryTopic) {
      setError("Topik industri wajib diisi untuk project Non-Emiten.");
      return;
    }

    setError(null);
    try {
      const isCreate = projectFormMode === "create";
      const url = isCreate
        ? "/api/projects"
        : `/api/projects/${selectedProjectId}`;
      const method = isCreate ? "POST" : "PATCH";
      const res = await fetch(url, {
        method,
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "Failed to save project");
      const rows = await refreshProjects();
      if (!rows) return;
      const nextId =
        (data.project?.id as string | undefined) ||
        (isCreate
          ? rows.find((p) => p.name === payload.name)?.id
          : selectedProjectId) ||
        null;
      if (nextId) setSelectedProjectId(nextId);
      setProjectFormMode(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to save project");
    }
  };

  const deleteProject = async () => {
    if (!selectedProjectId) return;
    if (selectedProjectId === DEFAULT_PROJECT_ID) {
      setError("Project bawaan tidak bisa dihapus. Buat project baru untuk memisahkan data.");
      return;
    }
    if (
      !confirm(
        "Hapus project ini beserta semua dokumen dan percakapan? Tindakan ini tidak bisa dibatalkan."
      )
    )
      return;
    setError(null);
    try {
      const res = await fetch(`/api/projects/${selectedProjectId}`, {
        method: "DELETE",
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "Failed to delete project");
      const rows = await refreshProjects();
      if (!rows) return;
      const next = rows[0]?.id || null;
      setSelectedProjectId(next);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to delete project");
    }
  };

  const newChat = () => {
    if (conversationStorageKey) localStorage.removeItem(conversationStorageKey);
    setConversationId(null);
    setMessages([]);
    setLastSources([]);
    setError(null);
  };

  const onUpload = (fileList: FileList | null) => {
    const file = fileList?.[0];
    if (!file || !selectedProjectId) return;
    setError(null);
    setUploadUi({ state: "uploading", percent: 0, determinate: false });

    const fd = new FormData();
    fd.append("projectId", selectedProjectId);
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
            if (data.document?.id) {
              setFocusedDocId(data.document.id);
              setSelectedDocIds((prev) =>
                prev.includes(data.document!.id) ? prev : [...prev, data.document!.id]
              );
            }
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

  const triggerProjectReingest = async () => {
    if (!selectedProjectId) return;
    setReingestLoading(true);
    setError(null);
    try {
      const res = await fetch(`/api/projects/${selectedProjectId}/reingest`, {
        method: "POST",
      });
      const data = (await res.json()) as { error?: string };
      if (!res.ok) throw new Error(data.error || "Gagal trigger re-ingest");
      await refreshProjects();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Gagal trigger re-ingest");
    } finally {
      setReingestLoading(false);
    }
  };

  const triggerBackfillIdxFileNames = async () => {
    if (!selectedProjectId) return;
    setBackfillIdxNamesLoading(true);
    setError(null);
    try {
      const res = await fetch(`/api/projects/${selectedProjectId}/backfill-idx-filenames`, {
        method: "POST",
      });
      const data = (await res.json()) as {
        error?: string;
        updated?: number;
        cacheHit?: boolean;
        hint?: string;
      };
      if (!res.ok) throw new Error(data.error || "Backfill nama gagal");
      if (!data.cacheHit && data.hint) {
        setError(data.hint);
      }
      await refreshProjects();
      await refreshDocuments();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Backfill nama gagal");
    } finally {
      setBackfillIdxNamesLoading(false);
    }
  };


  const sendMessage = async () => {
    const text = input.trim();
    if (!text || sending || !selectedProjectId) return;
    setSending(true);
    setError(null);
    const optimistic: MessageRow = {
      id: `temp-${Date.now()}`,
      conversation_id: conversationId || "temp",
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
          projectId: selectedProjectId,
          message: text,
          selectedDocumentIds: selectedDocIds,
        }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "Chat failed");
      const cid = data.conversationId as string;
      if (cid !== conversationId) {
        setConversationId(cid);
        if (conversationStorageKey) localStorage.setItem(conversationStorageKey, cid);
      }
      const sources = (data.reply?.sources || []) as ChatSource[];
      setLastSources(sources);
      const assistant: MessageRow = {
        id: `a-${Date.now()}`,
        conversation_id: cid,
        role: "assistant",
        content: data.reply?.content || "",
        sources_json: sources,
        created_at: new Date().toISOString(),
      };
      setMessages((m) => [...m, assistant]);
      void refreshConversations();
    } catch (e) {
      setMessages((m) => m.filter((x) => x.id !== optimistic.id));
      setError(e instanceof Error ? e.message : "Chat failed");
    } finally {
      setSending(false);
    }
  };

  const regenerateInsights = async () => {
    if (!focusedDocId || !selectedProjectId) return;
    setInsightsLoadingId(focusedDocId);
    setError(null);
    try {
      const res = await fetch(
        `/api/documents/${focusedDocId}/insights?projectId=${selectedProjectId}`,
        { method: "POST" }
      );
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
    if (!selectedProjectId) return;
    if (
      !confirm(
        "Hapus dokumen ini beserta index-nya? Tindakan ini tidak bisa dibatalkan."
      )
    )
      return;
    setError(null);
    try {
      const res = await fetch(
        `/api/documents/${id}?projectId=${selectedProjectId}`,
        { method: "DELETE" }
      );
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "Delete failed");
      if (focusedDocId === id) setFocusedDocId(null);
      setSelectedDocIds((prev) => prev.filter((x) => x !== id));
      await refreshDocuments();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Delete failed");
    }
  };

  const openDocumentInNewTab = (id: string) => {
    if (!selectedProjectId) return;
    // Opens the raw uploaded file in a separate tab (PDF will render, Excel will download).
    window.open(
      `/api/documents/${id}/file?projectId=${selectedProjectId}`,
      "_blank",
      "noopener,noreferrer"
    );
  };

  const renameDocument = async (id: string, currentName: string) => {
    if (!selectedProjectId) return;
    const next = prompt("Ubah nama dokumen", currentName);
    const fileName = next?.trim();
    if (!fileName) return;
    if (fileName === currentName) return;

    setError(null);
    try {
      const res = await fetch(`/api/documents/${id}?projectId=${selectedProjectId}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ fileName }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "Rename failed");
      await refreshDocuments();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Rename failed");
    }
  };

  const toggleDocSelected = (id: string) => {
    setSelectedDocIds((prev) =>
      prev.includes(id) ? prev.filter((x) => x !== id) : [...prev, id]
    );
  };

  const pickConversation = async (id: string) => {
    setConversationId(id);
    if (conversationStorageKey) localStorage.setItem(conversationStorageKey, id);
    await loadConversation(id);
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

      <div className="grid min-h-0 flex-1 grid-cols-[300px_1fr_340px]">
        <aside className="flex min-h-0 flex-col border-r border-zinc-800 bg-[var(--surface)]">
          <div className="space-y-2 border-b border-zinc-800 p-3">
            <div className="flex items-center justify-between">
              <span className="text-xs font-semibold uppercase tracking-wide text-zinc-500">
                Project
              </span>
              <button
                type="button"
                className="text-[11px] text-teal-500 hover:underline"
                onClick={openCreateProjectForm}
              >
                New
              </button>
            </div>
            <select
              value={selectedProjectId || ""}
              onChange={(e) => setSelectedProjectId(e.target.value || null)}
              className="w-full rounded-md border border-zinc-700 bg-zinc-900 px-2 py-1.5 text-xs text-zinc-100"
            >
              {projects.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.name}
                </option>
              ))}
            </select>
            <div className="flex gap-2">
              <button
                type="button"
                className="rounded border border-zinc-700 px-2 py-1 text-[11px] text-zinc-300 hover:bg-zinc-800"
                onClick={openEditProjectForm}
                disabled={!selectedProjectId}
              >
                Edit
              </button>
              <button
                type="button"
                className="rounded border border-red-900/40 px-2 py-1 text-[11px] text-red-300 hover:bg-red-950/50 disabled:cursor-not-allowed disabled:opacity-40"
                onClick={() => void deleteProject()}
                disabled={
                  !selectedProjectId || selectedProjectId === DEFAULT_PROJECT_ID
                }
                title={
                  selectedProjectId === DEFAULT_PROJECT_ID
                    ? "Project bawaan tidak bisa dihapus"
                    : "Hapus project yang dipilih beserta dokumen dan chat"
                }
              >
                Hapus
              </button>
            </div>
            {selectedProject?.project_type === "emiten" ? (
              <div className="flex items-center gap-2">
                <span className="rounded border border-zinc-700 px-1.5 py-0.5 text-[10px] text-zinc-400">
                  Auto-ingest: {selectedProject.ingest_status || "idle"}
                </span>
                <button
                  type="button"
                  onClick={() => void triggerProjectReingest()}
                  disabled={!selectedProjectId || reingestLoading}
                  className="rounded border border-indigo-800/50 px-2 py-0.5 text-[10px] text-indigo-300 hover:bg-indigo-950/40 disabled:opacity-40"
                >
                  {reingestLoading ? "Triggering..." : "Re-ingest"}
                </button>
                <button
                  type="button"
                  title="Samakan nama file dengan cache IDX lokal (OriginalFilename)"
                  onClick={() => void triggerBackfillIdxFileNames()}
                  disabled={!selectedProjectId || backfillIdxNamesLoading}
                  className="rounded border border-zinc-600 px-2 py-0.5 text-[10px] text-zinc-300 hover:bg-zinc-800/60 disabled:opacity-40"
                >
                  {backfillIdxNamesLoading ? "…" : "Sync nama IDX"}
                </button>
              </div>
            ) : null}
            {selectedProject?.project_type === "emiten" && emitenIngestStage ? (
              <p className="text-[10px] text-zinc-400">Progress: {emitenIngestStage}</p>
            ) : null}
            {selectedProject?.project_type === "emiten" && emitenIngestDetails.downloadingFile ? (
              <p className="text-[10px] text-zinc-500">
                Downloading: {emitenIngestDetails.downloadingFile}
              </p>
            ) : null}
            {selectedProject?.project_type === "emiten" && emitenIngestDetails.embeddingFile ? (
              <p className="text-[10px] text-zinc-500">
                Embedding: {emitenIngestDetails.embeddingFile}
              </p>
            ) : null}
            {selectedProject?.project_type === "emiten" &&
            (emitenIngestDetails.duplicateReadyCount > 0 ||
              emitenIngestDetails.skipDuplicateProjectCount > 0 ||
              emitenIngestDetails.skipNoFileCount > 0 ||
              emitenIngestDetails.skipUnsupportedCount > 0) ? (
              <p className="text-[10px] text-zinc-500">
                Skip reasons - duplicate cached: {emitenIngestDetails.duplicateReadyCount}, already in
                project: {emitenIngestDetails.skipDuplicateProjectCount}, missing file:{" "}
                {emitenIngestDetails.skipNoFileCount}, unsupported:{" "}
                {emitenIngestDetails.skipUnsupportedCount}
              </p>
            ) : null}
            {selectedProject?.project_type === "emiten" && selectedProject.ingest_updated_at ? (
              <p className="text-[10px] text-zinc-500">
                Last update: {formatUploadedAt(selectedProject.ingest_updated_at)}
              </p>
            ) : null}
            {selectedProject?.project_type === "emiten" && selectedProject.ingest_error ? (
              <p className="text-[10px] text-red-300">{selectedProject.ingest_error}</p>
            ) : null}
            {selectedProjectId === DEFAULT_PROJECT_ID ? (
              <p className="text-[10px] leading-snug text-zinc-500">
                Project bawaan tidak dapat dihapus. Pakai <span className="text-teal-500">New</span>{" "}
                untuk membuat project lain, lalu pilih project itu dan ketuk{" "}
                <span className="text-red-300/90">Hapus</span>.
              </p>
            ) : null}
            {projectFormMode ? (
              <div className="space-y-2 rounded-md border border-zinc-800 bg-zinc-900/40 p-2">
                <p className="text-[11px] font-medium text-zinc-200">
                  {projectFormMode === "create" ? "Project baru" : "Ubah project"}
                </p>
                <input
                  value={projectDraft.name}
                  onChange={(e) =>
                    setProjectDraft((p) => ({ ...p, name: e.target.value }))
                  }
                  placeholder="Nama project"
                  className="w-full rounded border border-zinc-700 bg-zinc-900 px-2 py-1 text-[11px] text-zinc-100"
                />
                <textarea
                  value={projectDraft.description}
                  onChange={(e) =>
                    setProjectDraft((p) => ({
                      ...p,
                      description: e.target.value,
                    }))
                  }
                  placeholder="Deskripsi (opsional)"
                  rows={2}
                  className="w-full resize-none rounded border border-zinc-700 bg-zinc-900 px-2 py-1 text-[11px] text-zinc-100"
                />
                <select
                  value={projectDraft.projectType}
                  onChange={(e) =>
                    setProjectDraft((p) => ({
                      ...p,
                      projectType: e.target.value as ProjectType,
                    }))
                  }
                  className="w-full rounded border border-zinc-700 bg-zinc-900 px-2 py-1 text-[11px] text-zinc-100"
                >
                  <option value="non_emiten">Non-Emiten</option>
                  <option value="emiten">Emiten</option>
                </select>
                {projectDraft.projectType === "emiten" ? (
                  <div className="grid grid-cols-2 gap-2">
                    <input
                      value={projectDraft.tickerSymbol}
                      onChange={(e) =>
                        setProjectDraft((p) => ({
                          ...p,
                          tickerSymbol: e.target.value.toUpperCase(),
                        }))
                      }
                      placeholder="Kode emiten (wajib)"
                      className="w-full rounded border border-zinc-700 bg-zinc-900 px-2 py-1 text-[11px] text-zinc-100"
                    />
                    <input
                      value={projectDraft.exchange}
                      onChange={(e) =>
                        setProjectDraft((p) => ({
                          ...p,
                          exchange: e.target.value.toUpperCase(),
                        }))
                      }
                      placeholder="Bursa (IDX)"
                      className="w-full rounded border border-zinc-700 bg-zinc-900 px-2 py-1 text-[11px] text-zinc-100"
                    />
                  </div>
                ) : (
                  <input
                    value={projectDraft.industryTopic}
                    onChange={(e) =>
                      setProjectDraft((p) => ({
                        ...p,
                        industryTopic: e.target.value,
                      }))
                    }
                    placeholder="Topik/Industri (wajib)"
                    className="w-full rounded border border-zinc-700 bg-zinc-900 px-2 py-1 text-[11px] text-zinc-100"
                  />
                )}
                <div className="flex gap-2">
                  <button
                    type="button"
                    onClick={() => void submitProjectForm()}
                    className="rounded border border-teal-800/50 px-2 py-1 text-[11px] text-teal-300 hover:bg-teal-950/40"
                  >
                    Simpan
                  </button>
                  <button
                    type="button"
                    onClick={() => setProjectFormMode(null)}
                    className="rounded border border-zinc-700 px-2 py-1 text-[11px] text-zinc-300 hover:bg-zinc-800"
                  >
                    Batal
                  </button>
                </div>
              </div>
            ) : null}
          </div>

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
                disabled={uploadUi.state !== "idle" || !selectedProjectId}
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
                    aria-valuenow={uploadUi.determinate ? uploadUi.percent : undefined}
                    aria-valuemin={0}
                    aria-valuemax={100}
                  >
                    <div
                      className="h-full rounded-full bg-teal-500 transition-[width] duration-150 ease-out"
                      style={{
                        width: uploadUi.determinate ? `${uploadUi.percent}%` : "40%",
                      }}
                    />
                  </div>
                </>
              ) : (
                <>
                  <span className="font-medium text-zinc-200">Processing…</span>
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

          {selectedDocIds.length > 0 ? (
            <div className="flex items-center justify-between border-b border-zinc-800 px-3 py-2">
              <span className="text-[11px] text-zinc-500">
                Chat filter: {selectedDocIds.length} docs
              </span>
              <button
                type="button"
                className="text-[11px] text-teal-500 hover:underline"
                onClick={() => setSelectedDocIds([])}
              >
                Clear
              </button>
            </div>
          ) : null}

          <div className="scroll-thin min-h-0 flex-1 overflow-y-auto p-2">
            <div className="mb-2">
              <p className="px-2 text-[10px] font-semibold uppercase tracking-wide text-zinc-500">
                Conversations
              </p>
              <ul className="mt-1 space-y-1">
                {conversations.map((c) => (
                  <li key={c.id}>
                    <button
                      type="button"
                      onClick={() => void pickConversation(c.id)}
                      className={`w-full rounded-md px-2 py-1.5 text-left text-[11px] transition ${
                        conversationId === c.id
                          ? "bg-zinc-800 text-zinc-100"
                          : "text-zinc-400 hover:bg-zinc-800/80"
                      }`}
                    >
                      <p className="truncate">{c.title || "Untitled chat"}</p>
                    </button>
                  </li>
                ))}
              </ul>
            </div>

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
                    <div
                      role="button"
                      tabIndex={0}
                      onClick={() => {
                        setFocusedDocId(d.id);
                      }}
                      onKeyDown={(e) => {
                        if (e.key === "Enter" || e.key === " ") {
                          e.preventDefault();
                          setFocusedDocId(d.id);
                        }
                      }}
                      className={`group flex w-full flex-col rounded-md border px-2 py-1.5 text-left text-xs transition ${
                        focusedDocId === d.id
                          ? "border-teal-600/40 bg-[var(--accent-muted)]"
                          : "border-transparent hover:bg-zinc-800/80"
                      }`}
                    >
                      <div className="flex items-center gap-2">
                        <input
                          type="checkbox"
                          className="h-3.5 w-3.5 accent-teal-500"
                          checked={selectedDocIds.includes(d.id)}
                          onChange={(e) => {
                            e.stopPropagation();
                            toggleDocSelected(d.id);
                          }}
                          onClick={(e) => e.stopPropagation()}
                        />
                        <span className="truncate text-[11px] font-medium text-zinc-200">
                          {d.file_name}
                        </span>
                      </div>

                      <div className="mt-0.5 text-[9px] text-zinc-600">
                        {formatUploadedAt(d.created_at)}
                      </div>

                      <div
                        className="mt-1 flex items-center gap-1"
                      >
                        <button
                          type="button"
                          onClick={(e) => {
                            e.stopPropagation();
                            void renameDocument(d.id, d.file_name);
                          }}
                          className="rounded border border-zinc-800 px-1 py-0.5 text-[9px] text-zinc-500 hover:bg-zinc-900/60 disabled:cursor-not-allowed disabled:opacity-40"
                          disabled={!selectedProjectId}
                          title="Rename dokumen"
                        >
                          Rename
                        </button>
                        <button
                          type="button"
                          onClick={(e) => {
                            e.stopPropagation();
                            openDocumentInNewTab(d.id);
                          }}
                          className="rounded border border-teal-900/45 px-1 py-0.5 text-[9px] text-teal-300/80 hover:bg-teal-950/40 disabled:cursor-not-allowed disabled:opacity-40"
                          disabled={!selectedProjectId}
                          title="Buka file dokumen di tab baru"
                        >
                          Buka
                        </button>
                        <button
                          type="button"
                          onClick={(e) => {
                            e.stopPropagation();
                            void deleteDocument(d.id);
                          }}
                          className="rounded border border-red-900/40 px-1 py-0.5 text-[9px] text-red-300 hover:bg-red-950/50 disabled:cursor-not-allowed disabled:opacity-40"
                          disabled={!selectedProjectId}
                          title="Hapus dokumen"
                        >
                          Hapus
                        </button>
                      </div>
                    </div>
                  </li>
                ))}
              </ul>
            )}
          </div>
        </aside>

        <main className="flex min-h-0 flex-col bg-[var(--background)]">
          <div className="flex items-center justify-between border-b border-zinc-800 px-4 py-2">
            <div className="flex items-center gap-2">
              <span className="text-xs font-medium text-zinc-500">Research chat</span>
              {selectedProject ? (
                <span className="rounded border border-zinc-700 px-1.5 py-0.5 text-[10px] text-zinc-400">
                  {selectedProject.project_type === "emiten"
                    ? "Mode Emiten"
                    : "Mode Non-Emiten"}
                </span>
              ) : null}
            </div>
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
                  {selectedProject?.project_type === "emiten"
                    ? "Project Emiten: tanya soal kinerja, valuasi, aksi korporasi, atau isu spesifik emiten. Upload dokumen pendukung untuk memperkaya konteks."
                    : "Project Non-Emiten: tanya soal tren industri, kompetitor, atau dinamika sektor. Upload dokumen riset/industri untuk memperkaya konteks."}
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
                placeholder={
                  selectedProject?.project_type === "emiten"
                    ? "Tanya soal emiten ini (kinerja, valuasi, aksi korporasi, dll)…"
                    : "Tanya soal project ini (industri, tren, kompetitor, dll)…"
                }
                className="min-h-[48px] flex-1 resize-none rounded-xl border border-zinc-700 bg-zinc-900/50 px-3 py-2 text-sm text-zinc-100 placeholder:text-zinc-600 focus:border-teal-600/50 focus:outline-none"
              />
              <button
                type="button"
                disabled={sending || !input.trim() || !selectedProjectId}
                onClick={() => void sendMessage()}
                className="self-end rounded-xl bg-teal-600 px-4 py-2 text-sm font-medium text-zinc-950 hover:bg-teal-500 disabled:opacity-40"
              >
                Send
              </button>
            </div>
          </div>
        </main>

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
                    <p className="font-mono text-[11px] text-teal-500">{s.fileName}</p>
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
              {focusedDocId ? (
                <button
                  type="button"
                  disabled={insightsLoadingId === focusedDocId}
                  onClick={() => void regenerateInsights()}
                  className="text-[11px] text-teal-500 hover:underline disabled:opacity-40"
                >
                  {insightsLoadingId === focusedDocId ? "Running…" : "Regenerate"}
                </button>
              ) : null}
            </div>
            <div className="scroll-thin min-h-0 flex-1 overflow-y-auto p-3">
              {!selectedDoc ? (
                <p className="text-xs text-zinc-500">
                  Select one document to view important info, red flags, and key metrics.
                </p>
              ) : selectedDoc.status !== "ready" ? (
                <p className="text-xs text-zinc-500">
                  Insights are available when the document is ready.
                </p>
              ) : !selectedDoc.insights_json ? (
                <p className="text-xs text-zinc-500">
                  No insights yet. They generate after indexing; use Regenerate if needed.
                </p>
              ) : (
                <div className="space-y-4 text-xs">
                  {(() => {
                    const ins = selectedDoc.insights_json;
                    const importantInfo = ins.importantInfo || [];
                    const redFlags = ins.redFlags || [];
                    const keyMetrics = ins.keyMetrics || [];
                    return (
                      <>
                        <section>
                          <h3 className="font-semibold text-zinc-200">
                            Important info
                          </h3>
                          {importantInfo.length === 0 ? (
                            <p className="mt-1 text-xs text-zinc-500">
                              Tidak ada poin penting yang cukup jelas dari cuplikan dokumen ini.
                            </p>
                          ) : (
                            <ul className="mt-1 list-disc space-y-1 pl-4 text-zinc-400">
                              {importantInfo.map((r, i) => (
                                <li key={i}>{r}</li>
                              ))}
                            </ul>
                          )}
                        </section>
                        <section>
                          <h3 className="font-semibold text-red-400">
                            Red flags
                          </h3>
                          {redFlags.length === 0 ? (
                            <p className="mt-1 text-xs text-zinc-500">
                              Tidak ada red flags yang jelas terdeteksi dari cuplikan dokumen ini.
                            </p>
                          ) : (
                            <ul className="mt-1 list-disc space-y-1 pl-4 text-zinc-400">
                              {redFlags.map((r, i) => (
                                <li key={i}>{r}</li>
                              ))}
                            </ul>
                          )}
                        </section>
                        <section>
                          <h3 className="font-semibold text-zinc-200">
                            Key metrics
                          </h3>
                          {keyMetrics.length === 0 ? (
                            <p className="mt-1 text-xs text-zinc-500">
                              Tidak ada metrik kunci yang cukup jelas dari cuplikan dokumen ini.
                            </p>
                          ) : (
                            <ul className="mt-2 space-y-2">
                              {keyMetrics.map((k, i) => (
                                <li
                                  key={i}
                                  className="flex justify-between gap-2 border-b border-zinc-800/80 pb-2 font-mono text-[11px]"
                                >
                                  <span className="text-zinc-500">{k.label}</span>
                                  <span className="text-right text-teal-400">
                                    {k.value}
                                  </span>
                                </li>
                              ))}
                            </ul>
                          )}
                        </section>
                      </>
                    );
                  })()}
                  <button
                    type="button"
                    onClick={() => void deleteDocument(selectedDoc.id)}
                    className="text-[11px] text-red-400 hover:underline"
                  >
                    Hapus dokumen
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
