import { describe, expect, it } from 'vitest';
import type { ChatReply } from '../data/contracts';
import { turnsFor, type ChatMessage } from './chat';

const user = (text: string): ChatMessage => ({ id: Math.random(), role: 'user', text } as ChatMessage);
const bot = (status: ChatReply['status'], text = 'answer'): ChatMessage =>
  ({ id: Math.random(), role: 'assistant', reply: { status, segments: status === 'answered' ? [{ text }] : [] } } as unknown as ChatMessage);

describe('turnsFor: the conversation sent to the backend', () => {
  it('sends earlier questions and answered replies, then the new question', () => {
    expect(turnsFor([user('What is NDVI?'), bot('answered', 'A greenness index.')], 'And NBR?')).toEqual([
      { role: 'user', text: 'What is NDVI?' },
      { role: 'assistant', text: 'A greenness index.' },
      { role: 'user', text: 'And NBR?' },
    ]);
  });

  it('never sends a withheld or declined reply', () => {
    const turns = turnsFor([user('q1'), bot('withheld'), user('q2'), bot('declined')], 'q3');
    expect(turns.every((t) => t.role === 'user')).toBe(true);
    expect(turns.map((t) => t.text)).toEqual(['q1', 'q2', 'q3']);
  });

  it('keeps within the backend limits (8 turns, 1000 characters each, 4000 in all, first turn a question)', () => {
    const history = Array.from({ length: 12 }, (_, i) => [user(`q${i} ${'x'.repeat(900)}`), bot('answered', 'y'.repeat(1500))]).flat();
    const turns = turnsFor(history, 'z'.repeat(1200));
    expect(turns.length).toBeLessThanOrEqual(8);
    expect(turns.every((t) => t.text.length <= 1000)).toBe(true);
    expect(turns.reduce((n, t) => n + t.text.length, 0)).toBeLessThanOrEqual(4000);
    expect(turns[0].role).toBe('user');
    expect(turns.at(-1)).toEqual({ role: 'user', text: 'z'.repeat(1000) });
  });
});
