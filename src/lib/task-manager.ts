/**
 * In-memory task manager — port of the Open WebUI TaskManager
 * (open_webui/utils/task.py + main.py /api/tasks routes, v0.12.5).
 *
 * Tracks every running chat-completion task with an AbortController so the
 * ORIGINAL frontend can:
 *   - poll GET /api/tasks/chat/{chat_id}   → { task_ids: [...] }
 *   - stop POST /api/tasks/chat/{id}/stop  → aborts the live generation
 *   - stop POST /api/tasks/stop/{task_id}  → aborts one task
 *
 * A "task" is one in-flight chat completion (one assistant message). Task ids
 * are surfaced through the /api/tasks endpoints; the controller wired into
 * the upstream LLM fetch makes `stop` cancel the Kilo gateway stream.
 */

export type RunningTask = {
  id: string;
  userId: string;
  chatId: string;
  messageId: string | null;
  model: string | null;
  startedAt: number;
  controller: AbortController;
};

/** taskId → task
 *
 * Stored on globalThis: Next.js dev (and bundler splits) can instantiate this
 * module once per route-handler graph — a plain module-level Map would give
 * /api/chat/completions and /api/tasks/* separate registries. The global
 * singleton keeps one shared registry in every execution mode. */
const tasks: Map<string, RunningTask> =
  ((globalThis as any).__nelthTaskRegistry ??= new Map<string, RunningTask>());

function key(userId: string, chatId: string): string {
  return `${userId}:${chatId}`;
}

/** Register a new running task and return its handle. */
export function registerTask(opts: {
  userId: string;
  chatId: string;
  messageId?: string | null;
  model?: string | null;
}): RunningTask {
  const task: RunningTask = {
    id: crypto.randomUUID(),
    userId: opts.userId,
    chatId: opts.chatId,
    messageId: opts.messageId ?? null,
    model: opts.model ?? null,
    startedAt: Date.now(),
    controller: new AbortController(),
  };
  tasks.set(task.id, task);
  return task;
}

/** Deregister a finished task (idempotent). */
export function completeTask(taskId: string): void {
  tasks.delete(taskId);
}

/** Task ids for a chat (scoped to the requesting user). */
export function getTaskIdsByChatId(userId: string, chatId: string): string[] {
  const out: string[] = [];
  for (const t of tasks.values()) {
    if (t.userId === userId && t.chatId === chatId) out.push(t.id);
  }
  return out;
}

/** All task ids for a user. */
export function getTaskIdsByUser(userId: string): string[] {
  const out: string[] = [];
  for (const t of tasks.values()) {
    if (t.userId === userId) out.push(t.id);
  }
  return out;
}

/** Abort + remove one task. Returns true when a task was stopped. */
export function stopTask(userId: string, taskId: string): boolean {
  const t = tasks.get(taskId);
  if (!t || t.userId !== userId) return false;
  tasks.delete(taskId);
  try {
    t.controller.abort(new Error('Task stopped by user'));
  } catch {
    /* already aborted */
  }
  return true;
}

/** Abort + remove every task for a chat. Returns the stopped count. */
export function stopTasksByChatId(userId: string, chatId: string): number {
  let stopped = 0;
  for (const t of [...tasks.values()]) {
    if (t.userId === userId && t.chatId === chatId) {
      if (stopTask(userId, t.id)) stopped++;
    }
  }
  void key;
  return stopped;
}
