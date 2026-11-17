import { useEffect, useState } from 'react';

/** A user's photo, or their initial when there is none (or it fails to load). */
export function UserAvatar({ name, src, size = 36 }: { name: string; src: string | null; size?: number }) {
  const [broken, setBroken] = useState(false);
  useEffect(() => setBroken(false), [src]);
  const style = { width: size, height: size, fontSize: Math.round(size * 0.42) };
  if (src && !broken) {
    // Google photos refuse requests that carry a referrer.
    return <img src={src} alt="" referrerPolicy="no-referrer" onError={() => setBroken(true)} style={style} className="shrink-0 rounded-full object-cover" />;
  }
  return (
    <span aria-hidden style={style} className="grid shrink-0 place-items-center rounded-full bg-accent/15 font-semibold uppercase text-accent shadow-[0_0_0_1px_rgba(69,208,196,0.4)]">
      {name.trim().charAt(0) || '?'}
    </span>
  );
}
