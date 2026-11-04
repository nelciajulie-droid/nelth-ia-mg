"use client";

/** Model picker dropdown fed by GET /api/models. */

import * as React from "react";
import { Check, ChevronsUpDown, Cpu, RefreshCw } from "lucide-react";
import type { ModelItem } from "@/lib/types";

import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";

export function ModelPicker({
  models,
  value,
  onChange,
  onRefresh,
  disabled = false,
}: {
  models: ModelItem[];
  value: string | null;
  onChange: (modelId: string) => void;
  onRefresh?: () => void;
  disabled?: boolean;
}) {
  const selected = models.find((model) => model.id === value) ?? null;

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button
          variant="outline"
          size="sm"
          disabled={disabled}
          className="h-8 max-w-[220px] gap-1.5 border-zinc-200 bg-white font-normal text-zinc-600 hover:border-emerald-300 hover:text-zinc-900"
          aria-label="Select model"
        >
          <Cpu className="size-3.5 shrink-0 text-emerald-600" aria-hidden />
          <span className="truncate">{selected ? selected.name : value ?? "Select model"}</span>
          <ChevronsUpDown className="size-3.5 shrink-0 text-zinc-400" aria-hidden />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" className="w-60">
        <DropdownMenuLabel className="text-xs text-zinc-400">Models</DropdownMenuLabel>
        <DropdownMenuSeparator />
        {models.length === 0 ? (
          <div className="px-2 py-3 text-center text-xs text-zinc-400">
            No models available.
            <br />
            Ask an admin to configure a connection.
          </div>
        ) : (
          <div className="scrollbar-thin max-h-64 overflow-y-auto">
            {models.map((model) => (
              <DropdownMenuItem
                key={model.id}
                onClick={() => onChange(model.id)}
                className="gap-2"
                aria-checked={model.id === value}
              >
                <span className="w-4 shrink-0">
                  {model.id === value ? (
                    <Check className="size-4 text-emerald-600" aria-hidden />
                  ) : null}
                </span>
                <span className="min-w-0 flex-1">
                  <span className="block truncate font-medium text-zinc-800">{model.name}</span>
                  {model.owned_by ? (
                    <span className="block truncate text-[11px] text-zinc-400">
                      {model.owned_by}
                    </span>
                  ) : null}
                </span>
              </DropdownMenuItem>
            ))}
          </div>
        )}
        {onRefresh ? (
          <>
            <DropdownMenuSeparator />
            <DropdownMenuItem onClick={onRefresh} className="gap-2 text-zinc-500">
              <RefreshCw className="size-3.5" aria-hidden /> Refresh models
            </DropdownMenuItem>
          </>
        ) : null}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
