import { Satellite } from 'lucide-react';
import { useCurrentBundle } from '../../data/queries';
import { useAnalysisState, useImageryState } from '../../data/viewState';
import { useEeTiles } from './eeTiles';

/** Is the map showing the READY analysis' own composite for the viewed year (so it is not "imagery only")? */
export function useImageryCoveredByAnalysis(): boolean {
  const im = useImageryState();
  const analysisState = useAnalysisState();
  const ownLayer = useCurrentBundle()?.layers.imagery.find((i) => i.year === im.requestedYear);
  return analysisState.state === 'READY' && !!ownLayer && !ownLayer.reference && im.source !== 'esri-current';
}

/**
 * Imagery honesty label — what the map is rendering right now, in the bottom status bar (never over the map).
 *
 * Everything about the imagery comes from imageryState (= what the map actually renders); the analysis has its own
 * status elsewhere, so this cell never repeats it. Without a READY analysis layer for the viewed year the map shows
 * REAL IMAGERY only, and says so. Previously a floating box over the top of the map (it covered the imagery).
 */
export function ImageryStatus() {
  const im = useImageryState();
  const bundle = useCurrentBundle();
  const year = im.requestedYear;
  const throttling = useEeTiles((s) => s.throttling);
  const ownLayer = bundle?.layers.imagery.find((i) => i.year === year);
  const coveredByAnalysis = useImageryCoveredByAnalysis();
  if (im.state === 'OFF' || im.state === 'NONE') return null;

  if (im.reference && ownLayer) {
    return (
      <div className="min-w-0" role="status" data-testid="reference-imagery">
        <div className="t-label flex items-center gap-1.5 text-warn"><Satellite size={11} />Reference imagery · desaturated</div>
        <div className="mt-1 truncate text-[11px] text-ink-3" title={`No ${ownLayer.sensor} tiles are served for ${year}.`}>No {ownLayer.sensor} tiles for {year}; statistics show the {year} composite.</div>
      </div>
    );
  }

  const attrs = {
    role: 'status', 'data-testid': 'real-imagery-label',
    'data-imagery': im.source === 'esri-current' ? 'basemap' : im.state === 'AVAILABLE' ? 'READY' : im.state,
    'data-source': im.source ?? '',
  };
  if (im.state === 'AVAILABLE') {
    return (
      <div className="min-w-0" {...attrs}>
        <div className={`t-label flex items-center gap-1.5 ${coveredByAnalysis ? 'text-live' : 'text-ink-2'}`}>
          <Satellite size={11} />{coveredByAnalysis ? 'Analysis composite' : im.source === 'esri-current' ? 'Current basemap imagery · no analysis' : 'Satellite imagery · no analysis'}
        </div>
        <div className="t-data mt-1 truncate text-[12.5px] text-ink" data-testid="imagery-line" title={im.label}>{im.label}</div>
        {throttling && im.provider === 'Google Earth Engine'
          ? <div className="mt-0.5 truncate text-[11px] text-warn" data-testid="imagery-throttled">Imagery throttled — retrying…</div>
          : <div className="mt-0.5 truncate text-[11px] text-ink-3">{im.provider === 'Google Earth Engine' ? 'Earth Engine · ' : ''}{coveredByAnalysis ? 'used by the validated analysis' : 'imagery only — not a TerraTrace result'}</div>}
      </div>
    );
  }
  if (im.state === 'UNAVAILABLE' || im.state === 'ERROR') {
    return (
      <div className="min-w-0" {...attrs}>
        <div className="t-label flex items-center gap-1.5 text-warn" data-testid="no-usable-imagery">
          <Satellite size={11} />{im.state === 'UNAVAILABLE' ? `${year} · imagery unavailable` : 'Imagery unavailable'}
        </div>
        <div className="mt-1 line-clamp-2 text-[11px] leading-snug text-ink-2" data-testid={im.state === 'ERROR' ? 'imagery-error' : 'imagery-message'} title={`${im.message ?? ''} Nothing is substituted.`}>
          {im.message} Nothing is substituted.
        </div>
      </div>
    );
  }
  return (
    <div className="min-w-0" {...attrs}>
      <div className="t-label flex items-center gap-1.5 text-ink-3" data-testid="imagery-loading"><Satellite size={11} />Loading satellite imagery · {year}</div>
    </div>
  );
}
