import { keepPreviousData, skipToken, useInfiniteQuery, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { supabase } from '../../lib/supabase';
import { useAuth } from '../../state/auth';

/** supabase/migrations/20261117130000_community.sql. Reads are public (RLS); writes need a session. */
export interface Post {
  id: string;
  author_id: string | null;
  author_name: string | null;
  author_avatar: string | null;
  title: string;
  body: string;
  tags: string[];
  scan_id: string | null;
  aoi_id: string | null;
  baseline: number | null;
  comparison: number | null;
  region: string | null;
  bbox: [number, number, number, number] | null;
  score: number;
  comment_count: number;
  created_at: string;
  updated_at: string;
}

export interface Comment {
  id: string;
  post_id: string;
  parent_id: string | null;
  author_id: string;
  body: string;
  deleted: boolean;
  score: number;
  created_at: string;
  updated_at: string;
  author: { display_name: string | null; avatar_url: string | null } | null;
}

export type Sort = 'hot' | 'new' | 'top';
export type VoteValue = -1 | 0 | 1;

export const LIMITS = { title: 200, body: 20000, comment: 10000, tags: 6 } as const;
export const TAG = /^[a-z0-9][a-z0-9-]{0,31}$/;
const PAGE = 20;
const FEED_COLUMNS = 'id, author_id, author_name, author_avatar, title, body, tags, scan_id, aoi_id, baseline, comparison, region, bbox, score, comment_count, created_at, updated_at';

function db() {
  if (!supabase) throw new Error('The community is not available in this version.');
  return supabase;
}

interface SupabaseError { code?: string; message?: string; details?: string | null; hint?: string | null; status?: number }

/** Supabase / Postgres errors → a sentence a person can act on (never raw SQL text in production; see devDetail). */
export function errorText(e: unknown): string {
  const err = e as SupabaseError;
  // PostgREST cannot see the table / view / function: the migrations are missing or its schema cache is stale.
  if (err?.code === 'PGRST205' || err?.code === 'PGRST202' || err?.code === '42P01') return 'The community is not set up on this server yet.';
  if (err?.code === '42501' || err?.status === 401 || err?.status === 403) return 'You need to be signed in (and the author) to do this.';
  if (err?.code === '23505') return 'You have already done that.';
  if (err?.code === '23514') return 'That was not accepted: check the length of the text and the tags.';
  if (err?.message && /fetch|network/i.test(err.message)) return 'The community could not be reached. Check your connection and try again.';
  return 'Something went wrong. Try again.';
}

/** The raw Supabase / PostgREST error (code · message · details · hint) — development builds only, else null. */
export function devDetail(e: unknown): string | null {
  if (!import.meta.env.DEV || e == null) return null;
  const err = e as SupabaseError;
  const parts = [err.code, err.message, err.details, err.hint].filter((x): x is string => !!x);
  return parts.length ? parts.join(' · ') : String(e);
}

/** supabase-js RETURNS errors instead of throwing, so nothing reaches the console by itself: log (dev) and throw. */
function fail(error: SupabaseError, op: string): never {
  if (import.meta.env.DEV) console.error(`[community] ${op} failed:`, error);
  throw error;
}

export const parseTags = (raw: string) =>
  [...new Set(raw.split(/[\s,#]+/).map((t) => t.trim().toLowerCase()).filter(Boolean))];

// ------------------------------------------------------------------------------------------------- reads (public)
export function useFeed(sort: Sort, tag: string | null, search: string) {
  return useInfiniteQuery({
    queryKey: ['community', 'feed', sort, tag, search],
    enabled: !!supabase,
    initialPageParam: 0,
    placeholderData: keepPreviousData,
    queryFn: async ({ pageParam }) => {
      let q = db().from('post_feed').select(FEED_COLUMNS);
      if (tag) q = q.contains('tags', [tag]);
      if (search.trim()) q = q.textSearch('search', search.trim(), { type: 'websearch', config: 'english' });
      q = sort === 'new' ? q.order('created_at', { ascending: false })
        : sort === 'top' ? q.order('score', { ascending: false }).order('created_at', { ascending: false })
        : q.order('hot', { ascending: false });
      const { data, error } = await q.range(pageParam * PAGE, pageParam * PAGE + PAGE - 1);
      if (error) fail(error, 'feed');
      return data as Post[];
    },
    getNextPageParam: (last, all) => (last.length === PAGE ? all.length : undefined),
    staleTime: 15_000,
  });
}

export function usePost(id: string | null) {
  return useQuery({
    queryKey: ['community', 'post', id],
    queryFn: id && supabase
      ? async () => {
        const { data, error } = await db().from('post_feed').select(FEED_COLUMNS).eq('id', id).maybeSingle();
        if (error) fail(error, 'post');
        return data as Post | null;
      }
      : skipToken,
  });
}

export function useComments(postId: string | null) {
  return useQuery({
    queryKey: ['community', 'comments', postId],
    queryFn: postId && supabase
      ? async () => {
        const { data, error } = await db().from('comments')
          .select('id, post_id, parent_id, author_id, body, deleted, score, created_at, updated_at, author:profiles(display_name, avatar_url)')
          .eq('post_id', postId).order('created_at', { ascending: true }).limit(1000);
        if (error) fail(error, 'comments');
        return data as unknown as Comment[];
      }
      : skipToken,
  });
}

/** The signed-in user's own votes on a post and its comments (RLS shows nobody else's). */
export function useMyVotes(postId: string | null, commentIds: string[]) {
  const uid = useAuth((s) => s.session?.user.id ?? null);
  return useQuery({
    queryKey: ['community', 'my-votes', uid, postId, commentIds.length],
    queryFn: uid && postId && supabase
      ? async () => {
        const filters = [`post_id.eq.${postId}`, ...(commentIds.length ? [`comment_id.in.(${commentIds.join(',')})`] : [])].join(',');
        const { data, error } = await db().from('votes').select('post_id, comment_id, value').or(filters);
        if (error) fail(error, 'my votes');
        const out: Record<string, VoteValue> = {};
        for (const v of data ?? []) out[(v.post_id ?? v.comment_id) as string] = v.value as VoteValue;
        return out;
      }
      : skipToken,
  });
}

/** My votes on a page of feed posts. */
export function useMyFeedVotes(postIds: string[]) {
  const uid = useAuth((s) => s.session?.user.id ?? null);
  return useQuery({
    queryKey: ['community', 'my-feed-votes', uid, postIds.join(',')],
    queryFn: uid && postIds.length && supabase
      ? async () => {
        const { data, error } = await db().from('votes').select('post_id, value').in('post_id', postIds);
        if (error) fail(error, 'my feed votes');
        return Object.fromEntries((data ?? []).map((v) => [v.post_id as string, v.value as VoteValue])) as Record<string, VoteValue>;
      }
      : skipToken,
  });
}

// ------------------------------------------------------------------------------------------------- writes (RLS)
export interface NewPost {
  title: string;
  body: string;
  tags: string[];
  scan_id?: string | null;
  aoi_id?: string | null;
  baseline?: number | null;
  comparison?: number | null;
  region?: string | null;
  bbox?: [number, number, number, number] | null;
}

export function useCreatePost() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (p: NewPost) => {
      const { data, error } = await db().from('posts').insert(p).select('id').single();
      if (error) fail(error, 'create post');
      return data.id as string;
    },
    onSuccess: () => qc.invalidateQueries({ queryKey: ['community', 'feed'] }),
  });
}

export function useUpdatePost() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async ({ id, ...patch }: { id: string; title: string; body: string; tags: string[] }) => {
      const { error } = await db().from('posts').update(patch).eq('id', id);
      if (error) fail(error, 'update post');
    },
    onSuccess: (_, v) => { void qc.invalidateQueries({ queryKey: ['community', 'post', v.id] }); void qc.invalidateQueries({ queryKey: ['community', 'feed'] }); },
  });
}

export function useDeletePost() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (id: string) => {
      const { error } = await db().from('posts').delete().eq('id', id);
      if (error) fail(error, 'delete post');
    },
    onSuccess: () => qc.invalidateQueries({ queryKey: ['community'] }),
  });
}

export function useAddComment(postId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async ({ body, parentId }: { body: string; parentId: string | null }) => {
      const { error } = await db().from('comments').insert({ post_id: postId, parent_id: parentId, body });
      if (error) fail(error, 'add comment');
    },
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['community', 'comments', postId] });
      void qc.invalidateQueries({ queryKey: ['community', 'post', postId] });
    },
  });
}

export function useDeleteComment(postId: string) {
  const qc = useQueryClient();
  return useMutation({
    // Soft delete: the reply tree stays; the body becomes "[deleted]" (trigger comments_guard).
    mutationFn: async (id: string) => {
      const { error } = await db().from('comments').update({ deleted: true }).eq('id', id);
      if (error) fail(error, 'delete comment');
    },
    onSuccess: () => qc.invalidateQueries({ queryKey: ['community', 'comments', postId] }),
  });
}

/** Set my vote on a post or comment: +1, -1, or 0 to withdraw it. Scores are updated by the database trigger. */
export async function castVote(kind: 'post' | 'comment', id: string, value: VoteValue, previous: VoteValue): Promise<void> {
  const uid = useAuth.getState().session?.user.id;
  if (!uid) throw Object.assign(new Error('not signed in'), { status: 401 });
  const col = kind === 'post' ? 'post_id' : 'comment_id';
  const votes = db().from('votes');
  const { error } = value === 0
    ? await votes.delete().eq('user_id', uid).eq(col, id)
    : previous === 0
      ? await votes.insert({ [col]: id, value })
      : await votes.update({ value }).eq('user_id', uid).eq(col, id);
  if (error) fail(error, 'vote');
}
