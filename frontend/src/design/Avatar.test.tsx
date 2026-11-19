import { describe, expect, it } from 'vitest';
import { fireEvent, render } from '@testing-library/react';
import { Avatar, avatarColors, initials } from './Avatar';

describe('Avatar', () => {
  it('derives initials', () => {
    expect(initials('Asha Verma')).toBe('AV');
    expect(initials('reader@example.com')).toBe('R');
    expect(initials('jean-luc picard')).toBe('JL');
    expect(initials('   ')).toBe('?');
  });

  it('gives each user one stable colour', () => {
    expect(avatarColors('6f1c2a4e-1d2b')).toEqual(avatarColors('6f1c2a4e-1d2b'));
    expect(avatarColors('user-a').background).not.toBe(avatarColors('user-b').background);
  });

  it('shows the photo, and falls back to initials when it fails to load', () => {
    const { container } = render(<Avatar name="Asha Verma" userId="u1" src="https://example.org/a.png" size="lg" />);
    const img = container.querySelector('img')!;
    expect(img.getAttribute('data-avatar')).toBe('image');
    expect(img.style.width).toBe('72px');
    fireEvent.error(img);
    const fallback = container.querySelector('[data-avatar="initials"]')!;
    expect(fallback.textContent).toBe('AV');
  });

  it('uses the user id, not the name, for the colour', () => {
    const a = render(<Avatar name="Old name" userId="same-id" size="sm" />).container.querySelector('span')!;
    const b = render(<Avatar name="New name" userId="same-id" size="sm" />).container.querySelector('span')!;
    expect(a.style.background).toBe(b.style.background);
  });

  it('shows the logo for official posts', () => {
    const { container } = render(<Avatar name="TERRATRACE" official />);
    expect(container.querySelector('[data-avatar="official"] svg')).not.toBeNull();
  });
});
