import { Activity, BookOpenText, ScanSearch } from 'lucide-react';
import { Badge, Tooltip } from '../../design';

/**
 * The three kinds of results TerraTrace shows (docs/QUICKSCAN_PLAN.md), labelled wherever their numbers appear so a
 * reader always knows how much weight a figure can carry.
 */
export type Tier = 'research' | 'live' | 'quick';

const TIERS = {
  research: {
    label: 'Research case study', tone: 'forest', Icon: BookOpenText,
    hint: 'Custom Random Forest classification and a reviewed research pipeline, with a PDF report. Accuracy is reported as agreement with reference labels.',
  },
  live: {
    label: 'Published analysis', tone: 'accent', Icon: Activity,
    hint: "TerraTrace's own forest-change method, computed for this area in Google Earth Engine and checked by its validity rules.",
  },
  quick: {
    label: 'Quick scan · public datasets, not validated for this area', tone: 'warn', Icon: ScanSearch,
    hint: 'Computed on request from public datasets (Landsat, Dynamic World, ESA CCI). Useful for a first look; not validated for this area and not a TerraTrace classification.',
  },
} as const;

export function TierBadge({ tier, className = '' }: { tier: Tier; className?: string }) {
  const t = TIERS[tier];
  return (
    <Tooltip content={t.hint}>
      <span tabIndex={0} className={`inline-flex max-w-full rounded-xs focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-accent ${className}`} data-tier={tier}>
        <Badge tone={t.tone} icon={<t.Icon size={11} className="shrink-0" />} className="!h-auto min-h-[22px] max-w-full !whitespace-normal py-1 text-left leading-snug">
          {t.label}
        </Badge>
      </span>
    </Tooltip>
  );
}
