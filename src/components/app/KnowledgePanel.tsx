"use client";

/**
 * Knowledge panel (right Sheet): list knowledge bases, create one, upload a
 * file and link it to a KB, and run a retrieval query test that shows sources.
 */

import * as React from "react";
import {
  BookOpen,
  FilePlus2,
  Loader2,
  RefreshCw,
  Search,
  Send,
  Trash2,
} from "lucide-react";
import { useToast } from "@/hooks/use-toast";
import { api, ApiError, uploadFile } from "@/lib/api-client";
import type { KnowledgeItem, RetrievalQueryResponse } from "@/lib/types";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
} from "@/components/ui/sheet";
import { Skeleton } from "@/components/ui/skeleton";

function normalizeKnowledgeList(data: unknown): KnowledgeItem[] {
  if (Array.isArray(data)) return data as KnowledgeItem[];
  if (data && typeof data === "object" && "items" in data) {
    const items = (data as { items?: unknown }).items;
    if (Array.isArray(items)) return items as KnowledgeItem[];
  }
  return [];
}

interface QueryResult {
  sourceName: string;
  chunks: string[];
}

export function KnowledgePanel({
  open,
  onOpenChange,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const { toast } = useToast();

  const [loading, setLoading] = React.useState(false);
  const [knowledgeBases, setKnowledgeBases] = React.useState<KnowledgeItem[]>([]);
  const [selectedKbId, setSelectedKbId] = React.useState<string>("");

  const [newKbName, setNewKbName] = React.useState("");
  const [newKbDescription, setNewKbDescription] = React.useState("");
  const [creating, setCreating] = React.useState(false);

  const [uploadingKbId, setUploadingKbId] = React.useState<string | null>(null);
  const fileInputRef = React.useRef<HTMLInputElement>(null);

  const [query, setQuery] = React.useState("");
  const [querying, setQuerying] = React.useState(false);
  const [queryResults, setQueryResults] = React.useState<QueryResult[] | null>(null);

  const refresh = React.useCallback(async () => {
    setLoading(true);
    try {
      const data = await api<unknown>("/api/v1/knowledge/");
      const items = normalizeKnowledgeList(data);
      setKnowledgeBases(items);
      setSelectedKbId((current) => {
        if (current && items.some((kb) => kb.id === current)) return current;
        return items[0]?.id ?? "";
      });
    } catch (err) {
      toast({
        title: "Failed to load knowledge bases",
        description: err instanceof ApiError || err instanceof Error ? err.message : "Unknown error",
        variant: "destructive",
      });
    } finally {
      setLoading(false);
    }
  }, [toast]);

  React.useEffect(() => {
    if (open) void refresh();
  }, [open, refresh]);

  async function createKnowledgeBase(event: React.FormEvent) {
    event.preventDefault();
    if (!newKbName.trim() || creating) return;
    setCreating(true);
    try {
      await api<KnowledgeItem>("/api/v1/knowledge/create", {
        method: "POST",
        body: { name: newKbName.trim(), description: newKbDescription.trim() },
      });
      toast({ title: "Knowledge base created", description: newKbName.trim() });
      setNewKbName("");
      setNewKbDescription("");
      await refresh();
    } catch (err) {
      toast({
        title: "Could not create knowledge base",
        description: err instanceof ApiError || err instanceof Error ? err.message : "Unknown error",
        variant: "destructive",
      });
    } finally {
      setCreating(false);
    }
  }

  function pickFileForKb(kbId: string) {
    setUploadingKbId(kbId);
    fileInputRef.current?.click();
  }

  async function handleFilePicked(event: React.ChangeEvent<HTMLInputElement>) {
    const kbId = uploadingKbId;
    const fileList = event.target.files;
    if (fileInputRef.current) fileInputRef.current.value = "";
    if (!kbId || !fileList || fileList.length === 0) {
      setUploadingKbId(null);
      return;
    }
    const file = fileList[0];
    try {
      const uploaded = await uploadFile(file);
      await api(`/api/v1/knowledge/${kbId}/file/add`, {
        method: "POST",
        body: { file_id: uploaded.id },
      });
      toast({ title: "File added", description: `${uploaded.name} indexed into the knowledge base` });
      await refresh();
    } catch (err) {
      toast({
        title: "Could not add file",
        description: err instanceof ApiError || err instanceof Error ? err.message : "Unknown error",
        variant: "destructive",
      });
    } finally {
      setUploadingKbId(null);
    }
  }

  async function runQuery(event: React.FormEvent) {
    event.preventDefault();
    if (!selectedKbId || !query.trim() || querying) return;
    setQuerying(true);
    setQueryResults(null);
    try {
      const response = await api<RetrievalQueryResponse>("/api/v1/retrieval/query", {
        method: "POST",
        body: { knowledge_id: selectedKbId, query: query.trim(), k: 4 },
      });
      const results: QueryResult[] = (response.sources ?? []).map((source) => ({
        sourceName:
          typeof source.source === "string"
            ? source.source
            : source.source?.name ?? "unknown source",
        chunks: (source.document ?? [])
          .map((chunk) => (typeof chunk === "string" ? chunk : JSON.stringify(chunk)))
          .filter((chunk) => chunk.length > 0),
      }));
      setQueryResults(results);
      if (results.length === 0) {
        toast({ title: "No sources matched", description: "Try a different query or upload more files." });
      }
    } catch (err) {
      toast({
        title: "Query failed",
        description: err instanceof ApiError || err instanceof Error ? err.message : "Unknown error",
        variant: "destructive",
      });
    } finally {
      setQuerying(false);
    }
  }

  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent side="right" className="flex w-full flex-col gap-0 p-0 sm:max-w-md md:max-w-lg">
        <SheetHeader className="border-b border-zinc-200 px-5 py-4">
          <SheetTitle className="flex items-center gap-2 text-zinc-900">
            <BookOpen className="size-5 text-emerald-600" aria-hidden /> Knowledge
          </SheetTitle>
          <SheetDescription>
            Knowledge bases power retrieval-augmented answers (RAG).
          </SheetDescription>
        </SheetHeader>

        <div className="scrollbar-thin flex-1 overflow-y-auto px-5 py-4">
          {/* Query test ------------------------------------------------ */}
          <section aria-labelledby="kb-query-heading" className="mb-6">
            <h3 id="kb-query-heading" className="mb-2 text-sm font-semibold text-zinc-800">
              Retrieval query test
            </h3>
            <form onSubmit={runQuery} className="flex flex-col gap-2">
              <div className="flex gap-2">
                <div className="min-w-0 flex-1">
                  <Label htmlFor="kb-select" className="sr-only">
                    Knowledge base
                  </Label>
                  <Select value={selectedKbId} onValueChange={setSelectedKbId}>
                    <SelectTrigger id="kb-select" className="w-full text-sm" aria-label="Knowledge base">
                      <SelectValue placeholder="Select a knowledge base" />
                    </SelectTrigger>
                    <SelectContent>
                      {knowledgeBases.map((kb) => (
                        <SelectItem key={kb.id} value={kb.id}>
                          {kb.name}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>
                <Button
                  type="submit"
                  disabled={!selectedKbId || !query.trim() || querying}
                  className="shrink-0 gap-1.5 bg-emerald-600 text-white hover:bg-emerald-700"
                >
                  {querying ? (
                    <Loader2 className="size-4 animate-spin" aria-hidden />
                  ) : (
                    <Send className="size-4" aria-hidden />
                  )}
                  Query
                </Button>
              </div>
              <div className="relative">
                <Search
                  className="pointer-events-none absolute left-2.5 top-1/2 size-4 -translate-y-1/2 text-zinc-400"
                  aria-hidden
                />
                <Input
                  value={query}
                  onChange={(event) => setQuery(event.target.value)}
                  placeholder="Ask something to test retrieval…"
                  aria-label="Retrieval query"
                  className="pl-8 text-sm"
                />
              </div>
            </form>

            {queryResults ? (
              <div className="mt-3 flex flex-col gap-2">
                {queryResults.map((result, index) => (
                  <div
                    key={`${result.sourceName}-${index}`}
                    className="rounded-xl border border-zinc-200 bg-white p-3"
                  >
                    <p className="mb-1 flex items-center gap-1.5 text-xs font-semibold text-emerald-700">
                      <FilePlus2 className="size-3.5" aria-hidden />
                      {result.sourceName}
                    </p>
                    {result.chunks.map((chunk, chunkIndex) => (
                      <p
                        key={chunkIndex}
                        className="mb-1 last:mb-0 rounded-lg bg-zinc-50 px-2.5 py-1.5 text-xs leading-relaxed text-zinc-600"
                      >
                        {chunk}
                      </p>
                    ))}
                  </div>
                ))}
              </div>
            ) : null}
          </section>

          {/* KB list ---------------------------------------------------- */}
          <section aria-labelledby="kb-list-heading" className="mb-6">
            <div className="mb-2 flex items-center justify-between">
              <h3 id="kb-list-heading" className="text-sm font-semibold text-zinc-800">
                Knowledge bases
              </h3>
              <Button
                type="button"
                variant="ghost"
                size="sm"
                onClick={() => void refresh()}
                className="h-7 gap-1.5 px-2 text-xs text-zinc-500"
              >
                <RefreshCw className="size-3.5" aria-hidden /> Refresh
              </Button>
            </div>

            {loading ? (
              <div className="flex flex-col gap-2">
                {Array.from({ length: 3 }).map((_, index) => (
                  <Skeleton key={index} className="h-20 rounded-xl" />
                ))}
              </div>
            ) : knowledgeBases.length === 0 ? (
              <p className="rounded-xl border border-dashed border-zinc-200 bg-zinc-50 px-4 py-6 text-center text-sm text-zinc-400">
                No knowledge bases yet — create one below.
              </p>
            ) : (
              <div className="flex flex-col gap-2">
                {knowledgeBases.map((kb) => (
                  <div
                    key={kb.id}
                    className="rounded-xl border border-zinc-200 bg-white p-3 shadow-sm transition-colors hover:border-emerald-200"
                  >
                    <div className="flex items-start justify-between gap-2">
                      <div className="min-w-0">
                        <p className="truncate text-sm font-semibold text-zinc-800">{kb.name}</p>
                        <p className="mt-0.5 line-clamp-2 text-xs text-zinc-500">
                          {kb.description || "No description"}
                        </p>
                      </div>
                      <span className="shrink-0 rounded-full bg-zinc-100 px-2 py-0.5 text-[11px] font-medium text-zinc-500">
                        {kb.file_count ?? 0} file{(kb.file_count ?? 0) === 1 ? "" : "s"}
                      </span>
                    </div>
                    <div className="mt-2 flex gap-2">
                      <Button
                        type="button"
                        variant="outline"
                        size="sm"
                        onClick={() => pickFileForKb(kb.id)}
                        disabled={uploadingKbId !== null}
                        className="h-7 gap-1.5 text-xs"
                      >
                        {uploadingKbId === kb.id ? (
                          <Loader2 className="size-3.5 animate-spin" aria-hidden />
                        ) : (
                          <FilePlus2 className="size-3.5 text-emerald-600" aria-hidden />
                        )}
                        Add file
                      </Button>
                      <Button
                        type="button"
                        variant="ghost"
                        size="sm"
                        onClick={() => {
                          setSelectedKbId(kb.id);
                          setQueryResults(null);
                          toast({ title: `Query target set to “${kb.name}”` });
                        }}
                        className="h-7 gap-1.5 text-xs text-zinc-500"
                      >
                        <Search className="size-3.5" aria-hidden /> Test this
                      </Button>
                    </div>
                  </div>
                ))}
              </div>
            )}
            <input
              ref={fileInputRef}
              type="file"
              hidden
              onChange={(event) => void handleFilePicked(event)}
              accept=".txt,.md,.csv,.json,.pdf,.docx,.pptx,.xlsx,.html,.xml,.epub,.rst"
            />
          </section>

          {/* Create KB ------------------------------------------------- */}
          <section aria-labelledby="kb-create-heading">
            <h3 id="kb-create-heading" className="mb-2 text-sm font-semibold text-zinc-800">
              Create knowledge base
            </h3>
            <form onSubmit={createKnowledgeBase} className="flex flex-col gap-2 rounded-xl border border-zinc-200 bg-zinc-50 p-3">
              <div className="flex flex-col gap-1.5">
                <Label htmlFor="kb-name" className="text-xs text-zinc-500">
                  Name
                </Label>
                <Input
                  id="kb-name"
                  value={newKbName}
                  onChange={(event) => setNewKbName(event.target.value)}
                  placeholder="Product docs"
                  className="h-9 bg-white text-sm"
                />
              </div>
              <div className="flex flex-col gap-1.5">
                <Label htmlFor="kb-description" className="text-xs text-zinc-500">
                  Description
                </Label>
                <Input
                  id="kb-description"
                  value={newKbDescription}
                  onChange={(event) => setNewKbDescription(event.target.value)}
                  placeholder="What lives in this collection?"
                  className="h-9 bg-white text-sm"
                />
              </div>
              <Button
                type="submit"
                disabled={!newKbName.trim() || creating}
                className="gap-1.5 bg-emerald-600 text-white hover:bg-emerald-700"
              >
                {creating ? <Loader2 className="size-4 animate-spin" aria-hidden /> : null}
                Create
              </Button>
            </form>
          </section>

          <p className="mt-6 flex items-center gap-1.5 text-[11px] text-zinc-400">
            <Trash2 className="size-3" aria-hidden />
            Tip: files attached directly in chat also become RAG context per-message.
          </p>
        </div>
      </SheetContent>
    </Sheet>
  );
}
