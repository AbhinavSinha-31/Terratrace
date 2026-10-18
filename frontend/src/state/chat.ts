import { create } from 'zustand';
import { ApiError, client } from '../data/client';
import type { ChatReply, ChatStage, ChatTurn } from '../data/contracts';

/**
 * AI chat state: one conversation per thread ('general' for the Ask page and the front-page pop-up; one per area and
 * window for the analysis panel). Kept in memory only — never persisted, never sent anywhere but POST /api/chat.
 */
export type ChatMessage =
  | { id: number; role: 'user'; text: string }
  | { id: number; role: 'assistant'; reply: ChatReply };

export interface AreaContextRef { aoiId: string; baseline: number; comparison: number }

export const GENERAL = 'general';
export const areaThread = (c: AreaContextRef) => `area:${c.aoiId}:${c.baseline}-${c.comparison}`;

const MAX_TURNS = 8;        // backend: ≤ 8 messages
const MAX_TEXT = 1000;      // backend: ≤ 1000 characters per message
const MAX_TOTAL = 4000;     // backend: ≤ 4000 characters in all

/** The capped conversation sent to the backend: earlier questions and ANSWERED replies only (withheld text never exists). */
export function turnsFor(history: ChatMessage[], question: string): ChatTurn[] {
  const turns: ChatTurn[] = [];
  for (const m of history) {
    if (m.role === 'user') turns.push({ role: 'user', text: m.text.slice(0, MAX_TEXT) });
    else if (m.reply.status === 'answered') turns.push({ role: 'assistant', text: m.reply.segments.map((s) => s.text).join('\n').slice(0, MAX_TEXT) });
  }
  turns.push({ role: 'user', text: question.slice(0, MAX_TEXT) });
  let out = turns.slice(-MAX_TURNS);
  while (out.length > 1 && (out[0].role !== 'user' || out.reduce((n, t) => n + t.text.length, 0) > MAX_TOTAL)) out = out.slice(1);
  return out;
}

interface ChatState {
  threads: Record<string, ChatMessage[]>;
  pending: Record<string, boolean>;
  /** What the backend is doing for a pending question (streamed stages; no model text). */
  stage: Record<string, ChatStage>;
  /** Id of the reply that just arrived: its checked segments are revealed one by one, once. */
  fresh: number | null;
  markRevealed(): void;
  askOpen: boolean;
  launcherOpen: boolean;
  openAsk(): void;
  closeAsk(): void;
  setLauncherOpen(open: boolean): void;
  send(thread: string, text: string, area?: AreaContextRef): Promise<void>;
  clear(thread: string): void;
}

let nextId = 1;

export const useChat = create<ChatState>((set, get) => ({
  threads: {},
  pending: {},
  stage: {},
  fresh: null,
  markRevealed: () => set({ fresh: null }),
  askOpen: false,
  launcherOpen: false,
  openAsk: () => set({ askOpen: true, launcherOpen: false }),
  closeAsk: () => set({ askOpen: false }),
  setLauncherOpen: (open) => set({ launcherOpen: open }),
  clear: (thread) => set((s) => ({ threads: { ...s.threads, [thread]: [] } })),
  send: async (thread, raw, area) => {
    const text = raw.trim().slice(0, MAX_TEXT);
    if (!text || get().pending[thread]) return;
    const history = get().threads[thread] ?? [];
    const messages = turnsFor(history, text);
    set((s) => ({ threads: { ...s.threads, [thread]: [...history, { id: nextId++, role: 'user', text }] }, pending: { ...s.pending, [thread]: true },
      stage: { ...s.stage, [thread]: 'sending' } }));
    let reply: ChatReply;
    try {
      const body = { messages, ...(area ? { aoi_id: area.aoiId, baseline: area.baseline, comparison: area.comparison } : {}) };
      reply = await client.chatStream(body, (st) => set((s) => ({ stage: { ...s.stage, [thread]: st } })));
    } catch (e) {
      // Only TerraTrace's own public message is shown (ApiError carries the backend's user_message).
      const message = e instanceof ApiError ? e.message : 'The AI chat is not available right now. Try again later.';
      reply = { status: 'unavailable', segments: [], message, reason_code: e instanceof ApiError ? e.code ?? null : null, notice: '' };
    }
    const id = nextId++;
    set((s) => ({ threads: { ...s.threads, [thread]: [...(s.threads[thread] ?? []), { id, role: 'assistant', reply }] }, pending: { ...s.pending, [thread]: false },
      fresh: reply.status === 'answered' && reply.segments.length > 1 ? id : s.fresh }));
  },
}));

if (import.meta.env.DEV && typeof window !== 'undefined') (window as unknown as { __ttChat: typeof useChat }).__ttChat = useChat;
