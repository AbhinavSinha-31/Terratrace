import { useUi } from '../../state/store';
import { areaThread } from '../../state/chat';
import { SectionLabel } from '../../design';
import { ChatPanel } from './ChatPanel';

const AREA_STARTERS = [
  'What did TerraTrace measure here?',
  'How reliable is this result?',
  'What does the reference context say about this area?',
];

/** Analysis-view chat: the backend answers from THIS area's stored TerraTrace data (and reference context) only. */
export function AreaChat({ inline = false }: { inline?: boolean }) {
  const id = useUi((s) => s.investigation.study?.id ?? null);
  const name = useUi((s) => s.investigation.study?.name ?? 'this area');
  const baseline = useUi((s) => s.investigation.baselineYear);
  const comparison = useUi((s) => s.investigation.comparisonYear);
  if (!id) return null;
  const area = { aoiId: id, baseline, comparison };
  const panel = (
    <ChatPanel thread={areaThread(area)} area={area} starters={AREA_STARTERS} compact={inline}
      greeting={`Ask about ${name} (${baseline}–${comparison}). Answers about this area use only TerraTrace's data for it, with dataset and year.`} />
  );
  if (!inline) return panel;
  return (
    <section data-testid="area-chat-inline">
      <SectionLabel>Ask about this area</SectionLabel>
      <div className="tt-well mt-2 h-[420px] p-3">{panel}</div>
    </section>
  );
}
