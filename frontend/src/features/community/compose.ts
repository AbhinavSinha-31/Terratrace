import { create } from 'zustand';
import { useUi } from '../../state/store';
import { useChat } from '../../state/chat';
import { requireSignIn } from '../../state/auth';

/** What "Discuss this analysis" pre-fills: the analysis a new post is about (its figures are read from the backend). */
export interface DiscussionSubject {
  aoiId: string | null;
  name: string;
  baseline?: number | null;
  comparison?: number | null;
  scanId?: string | null;
  region?: string | null;
  bbox?: [number, number, number, number] | null;
  tags?: string[];
}

export const useCompose = create<{ subject: DiscussionSubject | null; set(subject: DiscussionSubject | null): void }>((set) => ({
  subject: null,
  set: (subject) => set({ subject }),
}));

/** Open the new-post page about this analysis (asks guests to sign in first; the draft is kept for after). */
export function startDiscussion(subject: DiscussionSubject) {
  useCompose.getState().set(subject);
  useChat.getState().closeAsk();
  useUi.getState().openPage({ kind: 'new-post' });
  requireSignIn('Sign in to start a discussion. Reading the community works without an account.');
}
