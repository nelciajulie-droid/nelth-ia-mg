"use client";

/** Sticky app header: brand, mobile sidebar toggle, knowledge + user menu. */

import * as React from "react";
import { BookOpen, LogOut, Menu, Settings, Sparkles } from "lucide-react";
import type { SessionUser } from "@/lib/types";

import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";

export function AppHeader({
  user,
  onToggleSidebar,
  onOpenKnowledge,
  onOpenSettings,
  onSignOut,
}: {
  user: SessionUser;
  onToggleSidebar: () => void;
  onOpenKnowledge: () => void;
  onOpenSettings: () => void;
  onSignOut: () => void;
}) {
  const initials = user.name
    .split(/\s+/)
    .map((part) => part.charAt(0))
    .filter(Boolean)
    .slice(0, 2)
    .join("")
    .toUpperCase();

  return (
    <header className="sticky top-0 z-40 flex h-14 shrink-0 items-center justify-between gap-2 border-b border-zinc-200 bg-white/90 px-3 backdrop-blur md:px-4">
      <div className="flex min-w-0 items-center gap-2">
        <Button
          variant="ghost"
          size="icon"
          onClick={onToggleSidebar}
          className="size-9 rounded-lg text-zinc-500 hover:bg-zinc-100 md:hidden"
          aria-label="Open chat list"
        >
          <Menu className="size-5" aria-hidden />
        </Button>
        <div className="flex size-8 shrink-0 items-center justify-center rounded-lg bg-gradient-to-br from-emerald-500 to-teal-600 shadow-sm">
          <Sparkles className="size-4 text-white" aria-hidden />
        </div>
        <h1 className="truncate text-base font-semibold tracking-tight text-zinc-900">
          Open WebUI
        </h1>
        <Badge
          variant="outline"
          className="hidden border-emerald-200 bg-emerald-50 text-[10px] font-medium text-emerald-700 sm:inline-flex"
        >
          v0.12.5 · TS
        </Badge>
      </div>

      <div className="flex shrink-0 items-center gap-1">
        <Button
          variant="ghost"
          size="sm"
          onClick={onOpenKnowledge}
          className="h-9 gap-1.5 rounded-lg px-2.5 text-zinc-600 hover:bg-zinc-100 hover:text-emerald-700"
          aria-label="Open knowledge bases"
        >
          <BookOpen className="size-4" aria-hidden />
          <span className="hidden text-sm sm:inline">Knowledge</span>
        </Button>

        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <button
              type="button"
              aria-label="Open user menu"
              className="ml-1 flex size-9 items-center justify-center rounded-full outline-none ring-emerald-400/50 transition-shadow hover:ring-2 focus-visible:ring-2"
            >
              <Avatar className="size-8 border border-zinc-200">
                {user.profile_image_url ? (
                  <AvatarImage src={user.profile_image_url} alt={user.name} />
                ) : null}
                <AvatarFallback className="bg-zinc-100 text-xs font-semibold text-zinc-600">
                  {initials || "U"}
                </AvatarFallback>
              </Avatar>
            </button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end" className="w-56">
            <DropdownMenuLabel className="flex flex-col gap-0.5">
              <span className="truncate text-sm font-medium text-zinc-900">{user.name}</span>
              <span className="truncate text-xs font-normal text-zinc-400">{user.email}</span>
            </DropdownMenuLabel>
            <DropdownMenuSeparator />
            <DropdownMenuItem onClick={onOpenSettings} className="gap-2">
              <Settings className="size-4" aria-hidden /> Settings
              {user.role === "admin" ? (
                <span className="ml-auto rounded bg-emerald-50 px-1.5 py-0.5 text-[10px] font-medium text-emerald-700">
                  admin
                </span>
              ) : null}
            </DropdownMenuItem>
            <DropdownMenuItem onClick={onSignOut} className="gap-2 text-red-600 focus:text-red-600">
              <LogOut className="size-4" aria-hidden /> Sign out
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      </div>
    </header>
  );
}
