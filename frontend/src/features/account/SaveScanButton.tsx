import { Bookmark, BookmarkCheck } from 'lucide-react';
import { Button } from '../../design';
import type { AnalysisResult } from '../../data/contracts';
import { requireSignIn, useAuth } from '../../state/auth';
import { useIsSaved, useSaveScan } from './scans';

/** "Save scan": adds the open READY analysis to My scans (asks to sign in first). */
export function SaveScanButton({ result }: { result: AnalysisResult }) {
  const status = useAuth((s) => s.status);
  const save = useSaveScan();
  const saved = useIsSaved(result.id, result.window.baseline_year, result.window.comparison_year);
  if (status === 'unconfigured') return null;
  return (
    <Button size="sm" variant="secondary" data-testid="save-scan" disabled={save.isPending}
      icon={saved ? <BookmarkCheck size={14} className="text-accent" /> : <Bookmark size={14} />}
      title={save.isError ? (save.error as Error).message : undefined}
      onClick={() => { if (requireSignIn('Sign in to save this scan to your account.')) save.mutate(result); }}>
      {save.isPending ? 'Saving…' : saved ? 'Saved' : save.isError ? 'Retry save' : 'Save scan'}
    </Button>
  );
}
