import { useEffect, useState } from 'react';
import { TerratraceMark } from './Logo';

export type AvatarSize = 'sm' | 'md' | 'lg';
const PX: Record<AvatarSize, number> = { sm: 24, md: 36, lg: 72 };

/** Up to two initials: "Asha Verma" → "AV", "reader@example.com" → "R", "" → "?". */
export function initials(name: string): string {
  const base = name.includes('@') ? name.split('@')[0] : name;
  const words = base.split(/[\s._-]+/).filter(Boolean);
  if (!words.length) return '?';
  return (words.length > 1 ? words[0][0] + words[1][0] : words[0][0]).toUpperCase();
}

/** FNV-1a 32-bit: a stable number for a string (the same user always gets the same colour). */
function hash(s: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 0x01000193);
  return h >>> 0;
}

/** Background + text colour from the user id: one hue per user, muted to sit on the dark theme. */
export function avatarColors(key: string): { background: string; color: string } {
  const hue = hash(key) % 360;
  return { background: `hsl(${hue} 42% 30%)`, color: `hsl(${hue} 75% 86%)` };
}

interface Props {
  /** Display name (initials come from it). */
  name: string;
  /** profiles.avatar_url (or the Google photo); initials when null or when it fails to load. */
  src?: string | null;
  /** Colour key: the user id, so a user keeps their colour when they rename themselves. Falls back to the name. */
  userId?: string | null;
  size?: AvatarSize;
  /** An official TERRATRACE post: the site logo instead of a person. */
  official?: boolean;
  className?: string;
}

/** A user's photo, or their initials on a colour picked from their id. */
export function Avatar({ name, src, userId, size = 'md', official, className = '' }: Props) {
  const px = PX[size];
  const [broken, setBroken] = useState(false);
  useEffect(() => setBroken(false), [src]);
  const box = { width: px, height: px };
  const ring = 'shadow-[0_0_0_1px_rgba(255,255,255,0.12)]';
  if (official) {
    return (
      <span aria-hidden style={box} data-avatar="official"
        className={`grid shrink-0 place-items-center rounded-full bg-[#06181a] shadow-[0_0_0_1px_rgba(69,208,196,0.55)] ${className}`}>
        <TerratraceMark size={Math.round(px * 0.62)} />
      </span>
    );
  }
  if (src && !broken) {
    // Google photos refuse requests that carry a referrer.
    return <img src={src} alt="" referrerPolicy="no-referrer" onError={() => setBroken(true)} style={box} data-avatar="image"
      className={`shrink-0 rounded-full object-cover ${ring} ${className}`} />;
  }
  return (
    <span aria-hidden data-avatar="initials" style={{ ...box, ...avatarColors(userId || name), fontSize: Math.round(px * (size === 'sm' ? 0.42 : 0.38)) }}
      className={`grid shrink-0 select-none place-items-center rounded-full font-semibold tracking-wide ${ring} ${className}`}>
      {initials(name)}
    </span>
  );
}
