"use client";

/**
 * Settings dialog: Profile tab (everyone) and Connections tab (admin only,
 * OpenAI-compatible + Ollama connection management, with model refresh).
 */

import * as React from "react";
import { KeyRound, Loader2, LogOut, Plus, Save, Server, Trash2, UserRound } from "lucide-react";
import { useToast } from "@/hooks/use-toast";
import { api, ApiError } from "@/lib/api-client";
import type { SessionUser } from "@/lib/types";

import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Separator } from "@/components/ui/separator";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";

interface OpenAiConnection {
  baseUrl: string;
  apiKey: string;
}

export function SettingsDialog({
  open,
  onOpenChange,
  user,
  onSignOut,
  onModelsRefresh,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  user: SessionUser;
  onSignOut: () => void;
  onModelsRefresh: () => void | Promise<void>;
}) {
  const { toast } = useToast();
  const isAdmin = user.role === "admin";

  const [openai, setOpenai] = React.useState<OpenAiConnection[]>([]);
  const [ollamaUrls, setOllamaUrls] = React.useState<string[]>([]);
  const [savingOpenai, setSavingOpenai] = React.useState(false);
  const [savingOllama, setSavingOllama] = React.useState(false);

  React.useEffect(() => {
    if (!open || !isAdmin) return;
    let cancelled = false;
    (async () => {
      try {
        const config = await api<Record<string, unknown>>("/openai/config");
        if (cancelled) return;
        const baseUrls = Array.isArray(config.OPENAI_API_BASE_URLS)
          ? (config.OPENAI_API_BASE_URLS as string[])
          : [];
        const apiKeys = Array.isArray(config.OPENAI_API_KEYS)
          ? (config.OPENAI_API_KEYS as string[])
          : [];
        const connections =
          baseUrls.length > 0
            ? baseUrls.map((baseUrl, index) => ({
                baseUrl,
                apiKey: apiKeys[index] ?? "",
              }))
            : [];
        setOpenai(connections);
      } catch {
        /* config endpoint unavailable — start with an empty list */
      }
      try {
        const config = await api<Record<string, unknown>>("/ollama/config");
        if (cancelled) return;
        const urls = Array.isArray(config.OLLAMA_BASE_URLS)
          ? (config.OLLAMA_BASE_URLS as string[])
          : [];
        setOllamaUrls(urls.filter(Boolean));
      } catch {
        /* ignore */
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [open, isAdmin]);

  async function saveOpenAi() {
    const rows = openai.filter((row) => row.baseUrl.trim());
    if (rows.length === 0) {
      toast({ title: "Add at least one base URL", variant: "destructive" });
      return;
    }
    setSavingOpenai(true);
    try {
      await api("/openai/config/update", {
        method: "POST",
        body: {
          ENABLE_OPENAI_API: true,
          OPENAI_API_BASE_URLS: rows.map((row) => row.baseUrl.trim()),
          OPENAI_API_KEYS: rows.map((row) => row.apiKey.trim()),
        },
      });
      toast({ title: "OpenAI connections saved" });
      await onModelsRefresh();
    } catch (err) {
      toast({
        title: "Save failed",
        description: err instanceof ApiError || err instanceof Error ? err.message : "Unknown error",
        variant: "destructive",
      });
    } finally {
      setSavingOpenai(false);
    }
  }

  async function saveOllama() {
    const urls = ollamaUrls.map((url) => url.trim()).filter(Boolean);
    setSavingOllama(true);
    try {
      await api("/ollama/config/update", {
        method: "POST",
        body: {
          ENABLE_OLLAMA_API: true,
          OLLAMA_BASE_URLS: urls,
        },
      });
      toast({ title: "Ollama connections saved" });
      await onModelsRefresh();
    } catch (err) {
      toast({
        title: "Save failed",
        description: err instanceof ApiError || err instanceof Error ? err.message : "Unknown error",
        variant: "destructive",
      });
    } finally {
      setSavingOllama(false);
    }
  }

  const initials = user.name
    .split(/\s+/)
    .map((part) => part.charAt(0))
    .filter(Boolean)
    .slice(0, 2)
    .join("")
    .toUpperCase();

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[85vh] overflow-y-auto sm:max-w-lg">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <UserRound className="size-5 text-emerald-600" aria-hidden /> Settings
          </DialogTitle>
          <DialogDescription>Manage your profile and server connections.</DialogDescription>
        </DialogHeader>

        <Tabs defaultValue="profile">
          <TabsList className="grid w-full grid-cols-2">
            <TabsTrigger value="profile">Profile</TabsTrigger>
            {isAdmin ? <TabsTrigger value="connections">Connections</TabsTrigger> : null}
          </TabsList>

          <TabsContent value="profile" className="mt-4 flex flex-col gap-4">
            <div className="flex items-center gap-4">
              <Avatar className="size-16 border border-zinc-200">
                {user.profile_image_url ? (
                  <AvatarImage src={user.profile_image_url} alt={user.name} />
                ) : null}
                <AvatarFallback className="bg-emerald-50 text-lg font-semibold text-emerald-700">
                  {initials || "U"}
                </AvatarFallback>
              </Avatar>
              <div className="min-w-0">
                <p className="truncate text-base font-semibold text-zinc-900">{user.name}</p>
                <p className="truncate text-sm text-zinc-500">{user.email}</p>
                <Badge className="mt-1 bg-emerald-100 text-emerald-800 hover:bg-emerald-100">
                  {user.role}
                </Badge>
              </div>
            </div>

            <Separator />

            <div className="flex flex-col gap-1.5">
              <Label className="text-xs text-zinc-500">User ID</Label>
              <p className="break-all rounded-lg bg-zinc-50 px-3 py-2 font-mono text-xs text-zinc-600">
                {user.id}
              </p>
            </div>

            <Button
              variant="destructive"
              onClick={onSignOut}
              className="gap-1.5"
            >
              <LogOut className="size-4" aria-hidden /> Sign out
            </Button>
          </TabsContent>

          {isAdmin ? (
            <TabsContent value="connections" className="mt-4 flex flex-col gap-6">
              {/* OpenAI-compatible ---------------------------------------- */}
              <section aria-labelledby="openai-conn" className="flex flex-col gap-2.5">
                <div className="flex items-center gap-1.5">
                  <Server className="size-4 text-emerald-600" aria-hidden />
                  <h3 id="openai-conn" className="text-sm font-semibold text-zinc-800">
                    OpenAI-compatible connections
                  </h3>
                </div>
                <p className="text-xs text-zinc-400">
                  e.g. http://localhost:3030/v1 — models appear in the picker after saving.
                </p>
                {openai.map((row, index) => (
                  <div
                    key={index}
                    className="flex flex-col gap-2 rounded-xl border border-zinc-200 bg-zinc-50 p-3"
                  >
                    <div className="flex items-center justify-between">
                      <span className="text-xs font-medium text-zinc-500">Connection {index + 1}</span>
                      {openai.length > 1 ? (
                        <button
                          type="button"
                          onClick={() => setOpenai((prev) => prev.filter((_, i) => i !== index))}
                          aria-label={`Remove connection ${index + 1}`}
                          className="flex size-6 items-center justify-center rounded-md text-zinc-400 hover:bg-red-50 hover:text-red-600"
                        >
                          <Trash2 className="size-3.5" aria-hidden />
                        </button>
                      ) : null}
                    </div>
                    <div className="flex flex-col gap-1.5">
                      <Label className="text-xs text-zinc-500">Base URL</Label>
                      <Input
                        value={row.baseUrl}
                        onChange={(event) =>
                          setOpenai((prev) =>
                            prev.map((entry, i) =>
                              i === index ? { ...entry, baseUrl: event.target.value } : entry
                            )
                          )
                        }
                        placeholder="https://api.openai.com/v1"
                        className="h-9 bg-white font-mono text-xs"
                      />
                    </div>
                    <div className="flex flex-col gap-1.5">
                      <Label className="flex items-center gap-1 text-xs text-zinc-500">
                        <KeyRound className="size-3" aria-hidden /> API key
                      </Label>
                      <Input
                        type="password"
                        value={row.apiKey}
                        onChange={(event) =>
                          setOpenai((prev) =>
                            prev.map((entry, i) =>
                              i === index ? { ...entry, apiKey: event.target.value } : entry
                            )
                          )
                        }
                        placeholder="sk-…"
                        className="h-9 bg-white font-mono text-xs"
                        autoComplete="off"
                      />
                    </div>
                  </div>
                ))}
                <div className="flex gap-2">
                  <Button
                    type="button"
                    variant="outline"
                    size="sm"
                    onClick={() => setOpenai((prev) => [...prev, { baseUrl: "", apiKey: "" }])}
                    className="gap-1.5 text-xs"
                  >
                    <Plus className="size-3.5" aria-hidden /> Add connection
                  </Button>
                  <Button
                    type="button"
                    size="sm"
                    onClick={() => void saveOpenAi()}
                    disabled={savingOpenai}
                    className="ml-auto gap-1.5 bg-emerald-600 text-xs text-white hover:bg-emerald-700"
                  >
                    {savingOpenai ? (
                      <Loader2 className="size-3.5 animate-spin" aria-hidden />
                    ) : (
                      <Save className="size-3.5" aria-hidden />
                    )}
                    Save &amp; refresh models
                  </Button>
                </div>
              </section>

              <Separator />

              {/* Ollama ---------------------------------------------------- */}
              <section aria-labelledby="ollama-conn" className="flex flex-col gap-2.5">
                <div className="flex items-center gap-1.5">
                  <Server className="size-4 text-emerald-600" aria-hidden />
                  <h3 id="ollama-conn" className="text-sm font-semibold text-zinc-800">
                    Ollama connections
                  </h3>
                </div>
                {ollamaUrls.map((url, index) => (
                  <div key={index} className="flex items-center gap-2">
                    <Input
                      value={url}
                      onChange={(event) =>
                        setOllamaUrls((prev) =>
                          prev.map((entry, i) => (i === index ? event.target.value : entry))
                        )
                      }
                      placeholder="http://localhost:11434"
                      className="h-9 bg-white font-mono text-xs"
                    />
                    {ollamaUrls.length > 1 ? (
                      <button
                        type="button"
                        onClick={() =>
                          setOllamaUrls((prev) => prev.filter((_, i) => i !== index))
                        }
                        aria-label={`Remove Ollama URL ${index + 1}`}
                        className="flex size-8 shrink-0 items-center justify-center rounded-md text-zinc-400 hover:bg-red-50 hover:text-red-600"
                      >
                        <Trash2 className="size-3.5" aria-hidden />
                      </button>
                    ) : null}
                  </div>
                ))}
                <div className="flex gap-2">
                  <Button
                    type="button"
                    variant="outline"
                    size="sm"
                    onClick={() => setOllamaUrls((prev) => [...prev, ""])}
                    className="gap-1.5 text-xs"
                  >
                    <Plus className="size-3.5" aria-hidden /> Add URL
                  </Button>
                  <Button
                    type="button"
                    size="sm"
                    onClick={() => void saveOllama()}
                    disabled={savingOllama}
                    className="ml-auto gap-1.5 bg-emerald-600 text-xs text-white hover:bg-emerald-700"
                  >
                    {savingOllama ? (
                      <Loader2 className="size-3.5 animate-spin" aria-hidden />
                    ) : (
                      <Save className="size-3.5" aria-hidden />
                    )}
                    Save
                  </Button>
                </div>
              </section>
            </TabsContent>
          ) : null}
        </Tabs>
      </DialogContent>
    </Dialog>
  );
}
