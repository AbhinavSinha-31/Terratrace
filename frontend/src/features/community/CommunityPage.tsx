import { useEffect, useMemo, useState, type FormEvent } from 'react';
import { AnimatePresence } from 'framer-motion';
import { useQuery } from '@tanstack/react-query';
import { ArrowUpRight, Flame, Clock, MapPin, MessageSquare, MessagesSquare, PenSquare, Search, Satellite, Trash2, Trophy, Reply, Pencil } from 'lucide-react';
import { Avatar, Button, Segmented, Skeleton, StateView } from '../../design';
import { client } from '../../data/client';
import { useStudyAreas } from '../../data/queries';
import { fmtHa } from '../../lib/format';
import { useUi, type OverlayPage } from '../../state/store';
import { openSignIn, requireSignIn, useAuth } from '../../state/auth';
import { useMe } from '../account/profile';
import { FullPage } from '../shell/FullPage';
import { Markdown } from './Markdown';
import { useCompose } from './compose';
import {
  LIMITS, TAG, parseTags, useAddComment, useComments, useCreatePost, useDeleteComment, useDeletePost, useFeed,
  useMyFeedVotes, useMyVotes, usePost, useUpdatePost, type Comment, type Post, type Sort,
} from './api';
import {
  Author, CommentSkeleton, CommunityToasts, ErrorBody, FormError, Input, Labeled, PostCardSkeleton, TagChip, TextArea, TimeAgo,
  VoteControl, toast, toastError,
} from './ui';

const go = (page: OverlayPage) => useUi.getState().openPage(page);
const SUGGESTED_TAGS = ['deforestation', 'india', 'amazon', 'mining', 'fire', 'urban-heat', 'land-cover', 'methods', 'featured'];

/** Thumbnail of a post's linked analysis, as the backend gives it (imagery URLs are never built in the frontend):
 *  a featured area's card image, else the registered area's own thumbnail. */
function useAnalysisThumb(post: Pick<Post, 'aoi_id'>): string | null {
  const featured = useStudyAreas().data?.items;
  const f = post.aoi_id ? featured?.find((a) => a.id === post.aoi_id) : undefined;
  const custom = useQuery({
    queryKey: ['aoi-doc', post.aoi_id],
    queryFn: () => client.getAoi(post.aoi_id!),
    enabled: !!post.aoi_id && !!featured && !f,
    staleTime: Infinity,
    retry: false,
  });
  return f?.thumbnail_url || custom.data?.thumbnail_url || null;
}

function Thumb({ src, className = '' }: { src: string; className?: string }) {
  const [broken, setBroken] = useState(false);
  if (broken) return null;
  return (
    <div className={`relative shrink-0 overflow-hidden rounded-md bg-white/[0.03] shadow-[0_0_0_1px_rgba(255,255,255,0.08)] ${className}`} data-testid="post-thumb">
      <img src={src} alt="" loading="lazy" onError={() => setBroken(true)} className="h-full w-full object-cover transition duration-500 group-hover:scale-[1.06]" />
      <span className="absolute bottom-1 left-1 flex items-center gap-0.5 rounded-sm bg-black/60 px-1 py-px text-[9px] font-medium uppercase tracking-wider text-ink-2"><Satellite size={9} /> analysis</span>
    </div>
  );
}

// ------------------------------------------------------------------------------------- measured analysis card
/** The analysis a post is about, with figures read from the TERRATRACE backend (never from the post). */
function AnalysisCard({ aoiId, baseline, comparison, region }: { aoiId: string; baseline: number | null; comparison: number | null; region: string | null }) {
  const window = baseline && comparison ? { start: baseline, end: comparison } : null;
  const q = useQuery({
    queryKey: ['community', 'analysis-status', aoiId, baseline, comparison],
    queryFn: () => client.analysisStatus(aoiId, window ?? { start: 0, end: 0 }),
    enabled: !!window,
    retry: 1,
    staleTime: 60_000,
  });
  const k = (q.data as { kpis?: Record<string, number | null> } | undefined)?.kpis;
  const open = () => { useUi.getState().closePage(); useUi.getState().openAnalysis(aoiId, { window: window ?? undefined }); };
  const signed = (v: number) => `${v > 0 ? '+' : v < 0 ? '−' : ''}${fmtHa(Math.abs(v))} ha`;
  return (
    <section className="tt-panel space-y-3 p-4" data-testid="analysis-card" aria-label="Linked analysis">
      <div className="flex flex-wrap items-center gap-3">
        <Satellite size={16} className="text-accent" />
        <div className="min-w-0 flex-1">
          <div className="text-[12.5px] font-semibold text-ink">Linked analysis{region ? ` · ${region}` : ''}</div>
          <div className="t-data text-[11px] text-ink-3">{aoiId}{window ? ` · ${window.start}–${window.end}` : ''}</div>
        </div>
        <Button size="sm" variant="secondary" icon={<ArrowUpRight size={14} />} onClick={open}>Open analysis</Button>
      </div>
      {q.isLoading ? <Skeleton className="h-10 rounded-md" />
        : q.isError ? <p className="text-[11.5px] text-ink-3">The measured result could not be loaded right now (the analysis service may be offline).</p>
        : q.data?.status === 'READY' && k ? (
          <dl className="grid grid-cols-2 gap-3 text-[11.5px] sm:grid-cols-4">
            {k.net_change_ha != null && <div><dt className="text-ink-4">Net forest change</dt><dd className="t-data text-ink">{signed(k.net_change_ha)}</dd></div>}
            {k.gross_loss_ha != null && <div><dt className="text-ink-4">Gross loss</dt><dd className="t-data text-ink">{fmtHa(k.gross_loss_ha)} ha</dd></div>}
            {k.gross_gain_ha != null && <div><dt className="text-ink-4">Gross gain</dt><dd className="t-data text-ink">{fmtHa(k.gross_gain_ha)} ha</dd></div>}
            {k.event_count != null && <div><dt className="text-ink-4">Change events</dt><dd className="t-data text-ink">{k.event_count}</dd></div>}
          </dl>
        ) : (
          <p className="text-[11.5px] text-ink-3">
            {q.data?.status === 'NOT_RUN' ? 'This analysis has not been run for this window yet. Open it to run it.' : `Stored status: ${q.data?.status ?? 'unknown'}. Open the analysis for details.`}
          </p>
        )}
      <p className="text-[10.5px] text-ink-4">Figures come from TERRATRACE&apos;s stored analysis, not from the post text.</p>
    </section>
  );
}

// ------------------------------------------------------------------------------------------------------- feed
/** A feed row. The title is a stretched link (the whole card opens the post); votes, tags and time sit above it. */
function PostCard({ post, myVote }: { post: Post; myVote: -1 | 0 | 1 }) {
  const thumb = useAnalysisThumb(post);
  const excerpt = post.body.replace(/[#*_>`[\]()]/g, '').replace(/\s+/g, ' ').trim().slice(0, 240);
  return (
    <li className="group tt-panel relative flex gap-3 p-4 transition duration-200 hover:-translate-y-px hover:bg-white/[0.025] hover:shadow-[0_0_0_1px_rgba(69,208,196,0.28),0_14px_32px_-18px_rgba(69,208,196,0.45)] sm:gap-4" data-testid="post-card">
      <VoteControl kind="post" id={post.id} score={post.score} myVote={myVote} />
      <div className="min-w-0 flex-1">
        <Author userId={post.author_id} name={post.author_name} avatar={post.author_avatar} official={!post.author_id} when={post.created_at} />
        <h2 className="mt-2">
          <button onClick={() => go({ kind: 'post', id: post.id })} data-testid="post-link"
            className="text-left text-[16px] font-semibold leading-snug tracking-[-0.01em] text-ink transition-colors after:absolute after:inset-0 after:rounded-[inherit] after:content-[''] group-hover:text-accent focus-visible:outline-none focus-visible:after:shadow-[0_0_0_2px_rgba(69,208,196,0.7)]">
            {post.title}
          </button>
        </h2>
        {excerpt && <p className="mt-1.5 line-clamp-2 text-[12.5px] leading-relaxed text-ink-3">{excerpt}</p>}
        <div className="mt-3 flex flex-wrap items-center gap-1.5">
          {post.region && <span className="mr-1 flex items-center gap-1 text-[11px] text-ink-3"><MapPin size={12} />{post.region}</span>}
          {post.tags.map((t) => <TagChip key={t} label={t} onClick={() => go({ kind: 'community', tag: t })} />)}
          <span className="ml-auto flex items-center gap-1 pl-2 text-[11.5px] text-ink-3" aria-label={`${post.comment_count} comments`}><MessageSquare size={13} /> {post.comment_count}</span>
        </div>
      </div>
      {thumb && <Thumb src={thumb} className="hidden h-[92px] w-[132px] self-center sm:block" />}
    </li>
  );
}

function Feed({ tag }: { tag: string | null }) {
  const [sort, setSort] = useState<Sort>('hot');
  const [draft, setDraft] = useState('');
  const [search, setSearch] = useState('');
  const feed = useFeed(sort, tag, search);
  const posts = useMemo(() => feed.data?.pages.flat() ?? [], [feed.data]);
  const votes = useMyFeedVotes(posts.map((p) => p.id)).data ?? {};
  const startPost = () => { useCompose.getState().set(null); go({ kind: 'new-post' }); requireSignIn('Sign in to start a discussion.'); };
  const filtered = !!(search || tag);
  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-end justify-between gap-4">
        <div>
          <h1 id="community-title" className="t-h1 text-ink">Community</h1>
          <p className="mt-1.5 max-w-[560px] text-[12.5px] leading-relaxed text-ink-3">Discuss analyses and research reports: what the satellite record shows, what drives it, and what it misses. Anyone can read; sign in to post, comment and vote.</p>
        </div>
        <Button variant="brand" icon={<PenSquare size={15} />} onClick={startPost} data-testid="new-post">New post</Button>
      </div>
      <div className="space-y-3">
        <div className="flex flex-wrap items-center gap-3">
          <Segmented label="Sort posts" value={sort} onChange={(v) => setSort(v)} options={[
            { value: 'hot', label: <span className="flex items-center gap-1"><Flame size={13} />Hot</span> },
            { value: 'new', label: <span className="flex items-center gap-1"><Clock size={13} />New</span> },
            { value: 'top', label: <span className="flex items-center gap-1"><Trophy size={13} />Top</span> },
          ]} />
          <form className="relative min-w-[200px] flex-1" onSubmit={(e) => { e.preventDefault(); setSearch(draft); }} role="search">
            <Search size={14} className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-ink-4" />
            <Input aria-label="Search posts" placeholder="Search posts (press Enter)" value={draft} onChange={(e) => { setDraft(e.target.value); if (!e.target.value) setSearch(''); }} className="pl-8" data-testid="community-search" />
          </form>
        </div>
        <div className="no-scrollbar -mx-1 flex gap-1.5 overflow-x-auto px-1 py-1" role="group" aria-label="Filter by tag">
          <TagChip label="all" active={!tag} onClick={() => go({ kind: 'community' })} />
          {SUGGESTED_TAGS.map((t) => <TagChip key={t} label={t} active={tag === t} onClick={() => go(tag === t ? { kind: 'community' } : { kind: 'community', tag: t })} />)}
        </div>
      </div>
      {feed.isLoading ? <ul className="space-y-3.5" aria-busy="true" aria-label="Loading posts">{[0, 1, 2].map((i) => <PostCardSkeleton key={i} />)}</ul>
        : feed.isError ? <StateView kind="error" title="The community could not be loaded" onRetry={() => feed.refetch()}><ErrorBody error={feed.error} /></StateView>
        : !posts.length ? (
          <div className="tt-panel" data-testid="community-empty">
            <StateView kind="empty" title={filtered ? 'No posts match' : 'No discussions yet'}
              action={filtered
                ? <Button size="sm" variant="secondary" onClick={() => { setDraft(''); setSearch(''); go({ kind: 'community' }); }}>Clear filters</Button>
                : <Button size="sm" variant="brand" icon={<PenSquare size={14} />} onClick={startPost}>Start the first discussion</Button>}>
              {filtered ? `Nothing found${search ? ` for “${search}”` : ''}${tag ? ` in #${tag}` : ''}. Try another search or tag.` : 'Share what you found in an analysis, or ask the community about an area.'}
            </StateView>
          </div>
        ) : (
          <>
            <ul className="space-y-3.5">{posts.map((p) => <PostCard key={p.id} post={p} myVote={votes[p.id] ?? 0} />)}</ul>
            {feed.hasNextPage && <div className="flex justify-center"><Button variant="secondary" onClick={() => void feed.fetchNextPage()} disabled={feed.isFetchingNextPage}>{feed.isFetchingNextPage ? 'Loading…' : 'Load more'}</Button></div>}
          </>
        )}
    </div>
  );
}

// --------------------------------------------------------------------------------------------- comments (tree)
function CommentForm({ postId, parentId, onDone, autoFocus }: { postId: string; parentId: string | null; onDone?: () => void; autoFocus?: boolean }) {
  const [body, setBody] = useState('');
  const add = useAddComment(postId);
  const me = useMe();
  const submit = (e: FormEvent) => {
    e.preventDefault();
    if (!requireSignIn('Sign in to comment.')) return;
    if (!body.trim()) return;
    add.mutate({ body: body.trim(), parentId }, { onSuccess: () => { setBody(''); onDone?.(); }, onError: (err) => toastError(err) });
  };
  if (!me && !parentId) {
    return (
      <button className="tt-panel tt-press flex w-full items-center gap-3 p-3 text-left text-[12.5px] text-ink-3 hover:text-ink" onClick={() => openSignIn('Sign in to comment. Reading works without an account.')} data-testid="comment-sign-in">
        <MessagesSquare size={16} className="text-accent" /> Sign in to join the discussion…
      </button>
    );
  }
  return (
    <form onSubmit={submit} className="flex gap-2.5" data-testid={parentId ? 'reply-form' : 'comment-form'}>
      {me && <Avatar name={me.name} src={me.avatar} userId={me.id} size={parentId ? 'sm' : 'md'} className="mt-0.5" />}
      <div className="min-w-0 flex-1 space-y-2">
        <TextArea aria-label={parentId ? 'Reply' : 'Comment'} rows={parentId ? 2 : 3} maxLength={LIMITS.comment} value={body} onChange={(e) => setBody(e.target.value)} placeholder={parentId ? 'Write a reply (markdown)…' : 'Add a comment (markdown)…'} autoFocus={autoFocus} />
        <div className="flex gap-2">
          <Button type="submit" size="sm" variant="brand" disabled={add.isPending || !body.trim()}>{add.isPending ? 'Posting…' : parentId ? 'Reply' : 'Comment'}</Button>
          {onDone && <Button type="button" size="sm" variant="ghost" onClick={onDone}>Cancel</Button>}
        </div>
      </div>
    </form>
  );
}

/** One comment and its replies. Replies hang off a thread line under the parent's avatar (indent capped on phones). */
function CommentNode({ c, kids, votes, depth }: { c: Comment; kids: Map<string | null, Comment[]>; votes: Record<string, -1 | 0 | 1>; depth: number }) {
  const [replying, setReplying] = useState(false);
  const uid = useAuth((s) => s.session?.user.id ?? null);
  const del = useDeleteComment(c.post_id);
  const children = kids.get(c.id) ?? [];
  const name = c.author?.display_name ?? null;
  return (
    <li className="relative" data-testid="comment">
      <div className="flex gap-2.5">
        <div className="flex flex-col items-center">
          {c.deleted
            ? <span className="grid h-6 w-6 shrink-0 place-items-center rounded-full bg-white/[0.04] text-[10px] text-ink-4 shadow-[0_0_0_1px_rgba(255,255,255,0.08)]">–</span>
            : <Avatar name={name || 'Member'} src={c.author?.avatar_url} userId={c.author_id} size="sm" />}
          {children.length > 0 && <span aria-hidden className="mt-1.5 w-px flex-1 bg-white/[0.09]" />}
        </div>
        <div className="min-w-0 flex-1 pb-1">
          {c.deleted ? <div className="flex h-6 items-center text-[11.5px] italic text-ink-4">[deleted]</div> : (
            <>
              <div className="flex h-6 min-w-0 items-center gap-2 text-[11.5px] text-ink-3">
                <span className="truncate font-semibold text-ink" data-testid="author-name">{name || 'Member'}</span>
                <span aria-hidden className="text-ink-4">·</span>
                <TimeAgo when={c.created_at} />
              </div>
              <Markdown className="mt-0.5">{c.body}</Markdown>
              <div className="mt-1.5 flex items-center gap-3 text-[11.5px]">
                <VoteControl kind="comment" id={c.id} score={c.score} myVote={votes[c.id] ?? 0} compact />
                {depth < 6 && <button className="tt-press flex items-center gap-1 text-ink-3 hover:text-ink" onClick={() => { if (requireSignIn('Sign in to reply.')) setReplying((v) => !v); }} data-testid="reply"><Reply size={12} /> Reply</button>}
                {uid === c.author_id && <button className="tt-press flex items-center gap-1 text-ink-3 hover:text-bad" onClick={() => { if (window.confirm('Delete this comment? Replies stay.')) del.mutate(c.id, { onError: (e) => toastError(e) }); }}><Trash2 size={12} /> Delete</button>}
              </div>
            </>
          )}
          {replying && <div className="mt-2.5"><CommentForm postId={c.post_id} parentId={c.id} onDone={() => setReplying(false)} autoFocus /></div>}
          {children.length > 0 && (
            <ul className={`mt-3 space-y-4 ${depth >= 3 ? '-ml-8 sm:ml-0' : ''}`}>
              {children.map((k) => <CommentNode key={k.id} c={k} kids={kids} votes={votes} depth={depth + 1} />)}
            </ul>
          )}
        </div>
      </div>
    </li>
  );
}

// ------------------------------------------------------------------------------------------------------- post
function PostSkeleton() {
  return (
    <div className="space-y-4" aria-busy="true" aria-label="Loading the post">
      <div className="flex items-center gap-2.5"><Skeleton className="h-9 w-9 rounded-full" /><Skeleton className="h-3.5 w-40 rounded" /></div>
      <Skeleton className="h-8 w-3/4 rounded-md" />
      <div className="flex gap-1.5"><Skeleton className="h-7 w-20 rounded-full" /><Skeleton className="h-7 w-16 rounded-full" /></div>
      <Skeleton className="h-28 rounded-md" />
      <div className="space-y-2"><Skeleton className="h-3 w-full rounded" /><Skeleton className="h-3 w-11/12 rounded" /><Skeleton className="h-3 w-2/3 rounded" /></div>
    </div>
  );
}

function PostView({ id }: { id: string }) {
  const post = usePost(id);
  const comments = useComments(id);
  const list = comments.data ?? [];
  const votes = useMyVotes(id, list.map((c) => c.id)).data ?? {};
  const uid = useAuth((s) => s.session?.user.id ?? null);
  const del = useDeletePost();
  const [editing, setEditing] = useState(false);
  const kids = useMemo(() => {
    const m = new Map<string | null, Comment[]>();
    for (const c of list) m.set(c.parent_id, [...(m.get(c.parent_id) ?? []), c]);
    return m;
  }, [list]);

  if (post.isLoading) return <PostSkeleton />;
  if (post.isError) return <StateView kind="error" title="This post could not be loaded" onRetry={() => post.refetch()}><ErrorBody error={post.error} /></StateView>;
  const p = post.data;
  if (!p) return <StateView kind="empty" title="Post not found">It may have been deleted by its author.</StateView>;
  return (
    <article className="space-y-7" data-testid="post-page">
      {editing ? <PostEditor post={p} onDone={() => setEditing(false)} /> : (
        <div className="flex gap-3 sm:gap-4">
          <VoteControl kind="post" id={p.id} score={p.score} myVote={votes[p.id] ?? 0} />
          <div className="min-w-0 flex-1 space-y-4">
            <header className="space-y-3">
              <Author userId={p.author_id} name={p.author_name} avatar={p.author_avatar} official={!p.author_id} when={p.created_at} size="md" strong />
              <h1 id="community-title" className="text-[22px] font-semibold leading-tight tracking-[-0.015em] text-ink sm:text-[26px]" data-testid="post-title">{p.title}</h1>
              {(p.region || p.tags.length > 0) && (
                <div className="flex flex-wrap items-center gap-1.5">
                  {p.region && <span className="mr-1 flex items-center gap-1 text-[11.5px] text-ink-3"><MapPin size={12} />{p.region}</span>}
                  {p.tags.map((t) => <TagChip key={t} label={t} onClick={() => go({ kind: 'community', tag: t })} />)}
                </div>
              )}
            </header>
            {p.aoi_id && <AnalysisCard aoiId={p.aoi_id} baseline={p.baseline} comparison={p.comparison} region={p.region} />}
            <Markdown className="text-[13.5px]">{p.body}</Markdown>
            {uid && uid === p.author_id && (
              <div className="flex gap-2 pt-1">
                <Button size="sm" variant="ghost" icon={<Pencil size={13} />} onClick={() => setEditing(true)}>Edit</Button>
                <Button size="sm" variant="ghost" icon={<Trash2 size={13} />} disabled={del.isPending}
                  onClick={() => { if (window.confirm('Delete this post and its comments?')) del.mutate(p.id, { onSuccess: () => { toast('ok', 'Post deleted.'); go({ kind: 'community' }); }, onError: (e) => toastError(e) }); }}>Delete</Button>
              </div>
            )}
          </div>
        </div>
      )}
      <section aria-label="Comments" className="space-y-5 border-t border-line pt-6">
        <h2 className="t-h2 flex items-center gap-2 text-ink"><MessageSquare size={16} className="text-accent" />{p.comment_count} comment{p.comment_count === 1 ? '' : 's'}</h2>
        <CommentForm postId={p.id} parentId={null} />
        {comments.isLoading ? <div className="space-y-4"><CommentSkeleton /><CommentSkeleton /></div>
          : comments.isError ? <StateView kind="error" title="Comments could not be loaded" onRetry={() => comments.refetch()} compact><ErrorBody error={comments.error} /></StateView>
          : !list.length ? <p className="text-[12.5px] text-ink-3" data-testid="comments-empty">No comments yet — start the conversation.</p>
          : <ul className="space-y-5">{(kids.get(null) ?? []).map((c) => <CommentNode key={c.id} c={c} kids={kids} votes={votes} depth={0} />)}</ul>}
      </section>
    </article>
  );
}

// --------------------------------------------------------------------------------------------- create / edit
function useTagInput(initial: string[]) {
  const [raw, setRaw] = useState(initial.join(' '));
  const tags = parseTags(raw);
  const bad = tags.filter((t) => !TAG.test(t));
  const error = bad.length ? `Tags use lowercase letters, digits and dashes (not: ${bad.join(', ')}).` : tags.length > LIMITS.tags ? `At most ${LIMITS.tags} tags.` : null;
  return { raw, setRaw, tags, error };
}

function PostEditor({ post, onDone }: { post: Post; onDone(): void }) {
  const [title, setTitle] = useState(post.title);
  const [body, setBody] = useState(post.body);
  const tags = useTagInput(post.tags);
  const update = useUpdatePost();
  const submit = (e: FormEvent) => {
    e.preventDefault();
    if (tags.error) return;
    update.mutate({ id: post.id, title: title.trim(), body: body.trim(), tags: tags.tags }, { onSuccess: onDone, onError: (err) => toastError(err) });
  };
  return (
    <form onSubmit={submit} className="space-y-4">
      <Labeled label="Title" id="edit-title" count={title.length} max={LIMITS.title}><Input id="edit-title" value={title} onChange={(e) => setTitle(e.target.value)} maxLength={LIMITS.title} required /></Labeled>
      <Labeled label="Body (markdown)" id="edit-body" count={body.length} max={LIMITS.body}><TextArea id="edit-body" rows={10} value={body} onChange={(e) => setBody(e.target.value)} maxLength={LIMITS.body} required /></Labeled>
      <Labeled label="Tags" id="edit-tags" hint="Space or comma separated."><Input id="edit-tags" value={tags.raw} onChange={(e) => tags.setRaw(e.target.value)} /></Labeled>
      <FormError>{tags.error}</FormError>
      <div className="flex gap-2"><Button type="submit" variant="brand" disabled={update.isPending}>{update.isPending ? 'Saving…' : 'Save'}</Button><Button type="button" variant="ghost" onClick={onDone}>Cancel</Button></div>
    </form>
  );
}

function NewPost() {
  const subject = useCompose((s) => s.subject);
  const me = useMe();
  const create = useCreatePost();
  const [title, setTitle] = useState('');
  const [body, setBody] = useState('');
  const tags = useTagInput([]);
  const [preview, setPreview] = useState(false);
  useEffect(() => {
    if (!subject) return;
    const span = subject.baseline && subject.comparison ? `, ${subject.baseline}–${subject.comparison}` : '';
    setTitle((t) => t || `${subject.name}${span}`);
    tags.setRaw((r) => r || (subject.tags ?? []).join(' '));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [subject]);
  const submit = (e: FormEvent) => {
    e.preventDefault();
    if (!requireSignIn('Sign in to publish your post.')) return;
    if (tags.error) return;
    create.mutate({
      title: title.trim(), body: body.trim(), tags: tags.tags,
      scan_id: subject?.scanId ?? null, aoi_id: subject?.aoiId ?? null,
      baseline: subject?.aoiId ? subject?.baseline ?? null : null, comparison: subject?.aoiId ? subject?.comparison ?? null : null,
      region: subject?.region ?? null, bbox: subject?.bbox ?? null,
    }, {
      onSuccess: (id) => { useCompose.getState().set(null); toast('ok', 'Posted.'); go({ kind: 'post', id }); },
      onError: (err) => toastError(err),
    });
  };
  return (
    <form onSubmit={submit} className="space-y-5" data-testid="new-post-form">
      <div className="space-y-3">
        <h1 id="community-title" className="t-h1 text-ink">{subject ? 'Discuss this analysis' : 'New post'}</h1>
        {me && (
          <div className="flex items-center gap-2.5 text-[12px] text-ink-3" data-testid="composer-author">
            <Avatar name={me.name} src={me.avatar} userId={me.id} size="md" />
            <span>Posting as <b className="font-semibold text-ink">{me.name}</b></span>
          </div>
        )}
      </div>
      {!me && <FormError>You can draft here, but publishing needs an account. <button type="button" className="underline" onClick={() => openSignIn('Sign in to publish your post.')}>Sign in</button></FormError>}
      {subject?.aoiId && <AnalysisCard aoiId={subject.aoiId} baseline={subject.baseline ?? null} comparison={subject.comparison ?? null} region={subject.region ?? null} />}
      <Labeled label="Title" id="post-title" count={title.length} max={LIMITS.title}><Input id="post-title" value={title} onChange={(e) => setTitle(e.target.value)} maxLength={LIMITS.title} required minLength={3} /></Labeled>
      <Labeled label="Body (markdown)" id="post-body" count={body.length} max={LIMITS.body}
        hint="Say what you see and why it matters. Cite outside sources. The linked analysis' figures are shown from TERRATRACE automatically — don't retype them.">
        {preview ? <div className="tt-panel min-h-[160px] p-3"><Markdown>{body || '*Nothing to preview yet.*'}</Markdown></div>
          : <TextArea id="post-body" rows={10} value={body} onChange={(e) => setBody(e.target.value)} maxLength={LIMITS.body} required />}
      </Labeled>
      <Labeled label="Tags" id="post-tags" hint="Up to 6, space or comma separated (e.g. deforestation india).">
        <Input id="post-tags" value={tags.raw} onChange={(e) => tags.setRaw(e.target.value)} />
        {tags.tags.length > 0 && !tags.error && <div className="mt-2 flex flex-wrap gap-1.5">{tags.tags.map((t) => <TagChip key={t} label={t} />)}</div>}
      </Labeled>
      <FormError>{tags.error}</FormError>
      <div className="flex flex-wrap gap-2">
        <Button type="submit" variant="brand" disabled={create.isPending || !title.trim() || !body.trim() || !!tags.error} data-testid="publish-post">{create.isPending ? 'Publishing…' : 'Publish'}</Button>
        <Button type="button" variant="secondary" onClick={() => setPreview((v) => !v)}>{preview ? 'Edit' : 'Preview'}</Button>
      </div>
    </form>
  );
}

// ------------------------------------------------------------------------------------------------------- page
/** #/community (feed), #/community/<id> (post), #/community/new. Supabase; guests read, writes need sign-in. */
export function CommunityPage() {
  const page = useUi((s) => s.page);
  const status = useAuth((s) => s.status);
  const open = page?.kind === 'community' || page?.kind === 'post' || page?.kind === 'new-post';
  const key = page ? JSON.stringify(page) : '';
  const back = () => (page?.kind === 'community' ? useUi.getState().closePage() : go({ kind: 'community' }));
  return (
    <>
      <AnimatePresence>
        {open && (
          <FullPage pageKey={key} titleId="community-title" testId="community-page" onBack={back} backLabel={page?.kind === 'community' ? 'Back' : 'Community'}>
            {status === 'unconfigured' ? (
              <StateView kind="empty" title="The community is not available yet"><span id="community-title">It needs accounts, which are not switched on for this version of TERRATRACE.</span></StateView>
            ) : page?.kind === 'post' ? <PostView id={page.id} />
              : page?.kind === 'new-post' ? <NewPost />
              : <Feed tag={page?.kind === 'community' ? page.tag ?? null : null} />}
          </FullPage>
        )}
      </AnimatePresence>
      <CommunityToasts />
    </>
  );
}
