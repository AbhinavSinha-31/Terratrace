import { useEffect, useMemo, useState, type FormEvent } from 'react';
import { AnimatePresence } from 'framer-motion';
import { useQuery } from '@tanstack/react-query';
import { ArrowUpRight, Flame, Clock, MessageSquare, PenSquare, Search, Satellite, Trash2, Trophy, Reply, Pencil } from 'lucide-react';
import { Button, Segmented, Skeleton, StateView } from '../../design';
import { client } from '../../data/client';
import { fmtHa } from '../../lib/format';
import { useUi, type OverlayPage } from '../../state/store';
import { openSignIn, requireSignIn, useAuth } from '../../state/auth';
import { FullPage } from '../shell/FullPage';
import { Markdown } from './Markdown';
import { useCompose } from './compose';
import {
  LIMITS, TAG, parseTags, useAddComment, useComments, useCreatePost, useDeleteComment, useDeletePost, useFeed,
  useMyFeedVotes, useMyVotes, usePost, useUpdatePost, type Comment, type Post, type Sort,
} from './api';
import { Author, CommunityToasts, ErrorBody, FormError, Input, Labeled, TagChip, TextArea, VoteControl, toast, toastError } from './ui';

const go = (page: OverlayPage) => useUi.getState().openPage(page);
const SUGGESTED_TAGS = ['deforestation', 'india', 'amazon', 'mining', 'fire', 'urban-heat', 'land-cover', 'methods', 'featured'];

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
function PostCard({ post, myVote }: { post: Post; myVote: -1 | 0 | 1 }) {
  return (
    <li className="tt-panel flex gap-3 p-3.5" data-testid="post-card">
      <VoteControl kind="post" id={post.id} score={post.score} myVote={myVote} />
      <div className="min-w-0 flex-1">
        <Author name={post.author_name} avatar={post.author_avatar} official={!post.author_id} when={post.created_at} size={18} />
        <button onClick={() => go({ kind: 'post', id: post.id })} className="tt-press mt-1 block text-left text-[15px] font-semibold leading-snug text-ink hover:text-accent" data-testid="post-link">{post.title}</button>
        <p className="mt-1 line-clamp-2 text-[12.5px] leading-relaxed text-ink-3">{post.body.replace(/[#*_>`[\]()-]/g, '').slice(0, 280)}</p>
        <div className="mt-2.5 flex flex-wrap items-center gap-1.5">
          {post.region && <span className="text-[11px] text-ink-3">{post.region}</span>}
          {post.tags.map((t) => <TagChip key={t} label={t} onClick={() => go({ kind: 'community', tag: t })} />)}
          <span className="ml-auto flex items-center gap-1 text-[11.5px] text-ink-3"><MessageSquare size={13} /> {post.comment_count}</span>
        </div>
      </div>
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
  return (
    <div className="space-y-5">
      <div className="flex flex-wrap items-end justify-between gap-4">
        <div>
          <h1 id="community-title" className="t-h1 text-ink">Community</h1>
          <p className="mt-1 max-w-[560px] text-[12.5px] leading-relaxed text-ink-3">Discuss analyses and research reports: what the satellite record shows, what drives it, and what it misses. Anyone can read; sign in to post, comment and vote.</p>
        </div>
        <Button variant="brand" icon={<PenSquare size={15} />} onClick={() => { useCompose.getState().set(null); go({ kind: 'new-post' }); requireSignIn('Sign in to start a discussion.'); }} data-testid="new-post">New post</Button>
      </div>
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
      <div className="no-scrollbar -mx-1 flex gap-1.5 overflow-x-auto px-1 pb-1">
        <TagChip label="all" active={!tag} onClick={() => go({ kind: 'community' })} />
        {SUGGESTED_TAGS.map((t) => <TagChip key={t} label={t} active={tag === t} onClick={() => go({ kind: 'community', tag: t })} />)}
      </div>
      {feed.isLoading ? <div className="space-y-3"><Skeleton className="h-24 rounded-md" /><Skeleton className="h-24 rounded-md" /></div>
        : feed.isError ? <StateView kind="error" title="The community could not be loaded" onRetry={() => feed.refetch()}><ErrorBody error={feed.error} /></StateView>
        : !posts.length ? <StateView kind="empty" title={search || tag ? 'No posts match' : 'No posts yet'}>{search || tag ? 'Try another search or tag.' : 'Start the first discussion.'}</StateView>
        : (
          <>
            <ul className="space-y-3">{posts.map((p) => <PostCard key={p.id} post={p} myVote={votes[p.id] ?? 0} />)}</ul>
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
  const signedIn = useAuth((s) => s.status === 'signed-in');
  const submit = (e: FormEvent) => {
    e.preventDefault();
    if (!requireSignIn('Sign in to comment.')) return;
    if (!body.trim()) return;
    add.mutate({ body: body.trim(), parentId }, { onSuccess: () => { setBody(''); onDone?.(); }, onError: (err) => toastError(err) });
  };
  if (!signedIn && !parentId) {
    return <button className="tt-panel tt-press w-full p-3 text-left text-[12.5px] text-ink-3 hover:text-ink" onClick={() => openSignIn('Sign in to comment. Reading works without an account.')} data-testid="comment-sign-in">Sign in to join the discussion…</button>;
  }
  return (
    <form onSubmit={submit} className="space-y-2" data-testid={parentId ? 'reply-form' : 'comment-form'}>
      <TextArea aria-label={parentId ? 'Reply' : 'Comment'} rows={parentId ? 2 : 3} maxLength={LIMITS.comment} value={body} onChange={(e) => setBody(e.target.value)} placeholder={parentId ? 'Write a reply (markdown)…' : 'Add a comment (markdown)…'} autoFocus={autoFocus} />
      <div className="flex gap-2">
        <Button type="submit" size="sm" variant="brand" disabled={add.isPending || !body.trim()}>{add.isPending ? 'Posting…' : parentId ? 'Reply' : 'Comment'}</Button>
        {onDone && <Button type="button" size="sm" variant="ghost" onClick={onDone}>Cancel</Button>}
      </div>
    </form>
  );
}

function CommentNode({ c, kids, votes, depth }: { c: Comment; kids: Map<string | null, Comment[]>; votes: Record<string, -1 | 0 | 1>; depth: number }) {
  const [replying, setReplying] = useState(false);
  const uid = useAuth((s) => s.session?.user.id ?? null);
  const del = useDeleteComment(c.post_id);
  const children = kids.get(c.id) ?? [];
  return (
    <li className="flex gap-2" data-testid="comment">
      <VoteControl kind="comment" id={c.id} score={c.score} myVote={votes[c.id] ?? 0} compact />
      <div className="min-w-0 flex-1">
        {c.deleted ? <span className="text-[11.5px] italic text-ink-4">[deleted]</span> : (
          <>
            <Author name={c.author?.display_name ?? null} avatar={c.author?.avatar_url ?? null} when={c.created_at} size={18} />
            <Markdown className="mt-1">{c.body}</Markdown>
            <div className="mt-1 flex gap-3 text-[11.5px]">
              {depth < 6 && <button className="tt-press flex items-center gap-1 text-ink-3 hover:text-ink" onClick={() => { if (requireSignIn('Sign in to reply.')) setReplying((v) => !v); }} data-testid="reply"><Reply size={12} /> Reply</button>}
              {uid === c.author_id && <button className="tt-press flex items-center gap-1 text-ink-3 hover:text-bad" onClick={() => { if (window.confirm('Delete this comment? Replies stay.')) del.mutate(c.id, { onError: (e) => toastError(e) }); }}><Trash2 size={12} /> Delete</button>}
            </div>
          </>
        )}
        {replying && <div className="mt-2"><CommentForm postId={c.post_id} parentId={c.id} onDone={() => setReplying(false)} autoFocus /></div>}
        {children.length > 0 && (
          <ul className="mt-3 space-y-3 border-l border-line pl-3">
            {children.map((k) => <CommentNode key={k.id} c={k} kids={kids} votes={votes} depth={depth + 1} />)}
          </ul>
        )}
      </div>
    </li>
  );
}

// ------------------------------------------------------------------------------------------------------- post
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

  if (post.isLoading) return <div className="space-y-3"><Skeleton className="h-10 w-2/3 rounded-md" /><Skeleton className="h-40 rounded-md" /></div>;
  if (post.isError) return <StateView kind="error" title="This post could not be loaded" onRetry={() => post.refetch()}><ErrorBody error={post.error} /></StateView>;
  const p = post.data;
  if (!p) return <StateView kind="empty" title="Post not found">It may have been deleted by its author.</StateView>;
  return (
    <article className="space-y-6" data-testid="post-page">
      {editing ? <PostEditor post={p} onDone={() => setEditing(false)} /> : (
        <div className="flex gap-3">
          <VoteControl kind="post" id={p.id} score={p.score} myVote={votes[p.id] ?? 0} />
          <div className="min-w-0 flex-1 space-y-3">
            <Author name={p.author_name} avatar={p.author_avatar} official={!p.author_id} when={p.created_at} />
            <h1 id="community-title" className="t-h1 text-ink" data-testid="post-title">{p.title}</h1>
            {p.tags.length > 0 && <div className="flex flex-wrap gap-1.5">{p.tags.map((t) => <TagChip key={t} label={t} onClick={() => go({ kind: 'community', tag: t })} />)}</div>}
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
      <section aria-label="Comments" className="space-y-4 border-t border-line pt-5">
        <h2 className="t-h2 text-ink">{p.comment_count} comment{p.comment_count === 1 ? '' : 's'}</h2>
        <CommentForm postId={p.id} parentId={null} />
        {comments.isLoading ? <Skeleton className="h-16 rounded-md" />
          : comments.isError ? <StateView kind="error" title="Comments could not be loaded" onRetry={() => comments.refetch()} compact><ErrorBody error={comments.error} /></StateView>
          : <ul className="space-y-4">{(kids.get(null) ?? []).map((c) => <CommentNode key={c.id} c={c} kids={kids} votes={votes} depth={0} />)}</ul>}
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
  const status = useAuth((s) => s.status);
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
    <form onSubmit={submit} className="space-y-4" data-testid="new-post-form">
      <h1 id="community-title" className="t-h1 text-ink">{subject ? 'Discuss this analysis' : 'New post'}</h1>
      {status !== 'signed-in' && <FormError>You can draft here, but publishing needs an account. <button type="button" className="underline" onClick={() => openSignIn('Sign in to publish your post.')}>Sign in</button></FormError>}
      {subject?.aoiId && <AnalysisCard aoiId={subject.aoiId} baseline={subject.baseline ?? null} comparison={subject.comparison ?? null} region={subject.region ?? null} />}
      <Labeled label="Title" id="post-title" count={title.length} max={LIMITS.title}><Input id="post-title" value={title} onChange={(e) => setTitle(e.target.value)} maxLength={LIMITS.title} required minLength={3} /></Labeled>
      <Labeled label="Body (markdown)" id="post-body" count={body.length} max={LIMITS.body}
        hint="Say what you see and why it matters. Cite outside sources. The linked analysis' figures are shown from TERRATRACE automatically — don't retype them.">
        {preview ? <div className="tt-panel min-h-[160px] p-3"><Markdown>{body || '*Nothing to preview yet.*'}</Markdown></div>
          : <TextArea id="post-body" rows={10} value={body} onChange={(e) => setBody(e.target.value)} maxLength={LIMITS.body} required />}
      </Labeled>
      <Labeled label="Tags" id="post-tags" hint="Up to 6, space or comma separated (e.g. deforestation india)."><Input id="post-tags" value={tags.raw} onChange={(e) => tags.setRaw(e.target.value)} /></Labeled>
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
