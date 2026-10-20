import { forwardRef, type ButtonHTMLAttributes, type ReactNode } from 'react';

type Variant = 'primary' | 'brand' | 'outline' | 'accent' | 'secondary' | 'ghost';
type Size = 'sm' | 'md' | 'lg';

const VARIANT: Record<Variant, string> = {
  // Off-white primary: the single highest-emphasis action on a surface.
  primary: 'bg-ink text-base hover:bg-white shadow-[0_1px_0_rgba(255,255,255,0.4)_inset,0_6px_16px_-8px_rgba(0,0,0,0.8)]',
  // Brand action: the one dominant call to action per screen.
  brand: 'bg-accent text-[#03201d] hover:bg-[#62e0d5] shadow-[0_1px_0_rgba(255,255,255,0.45)_inset,0_10px_28px_-10px_rgba(69,208,196,0.65)] hover:shadow-[0_1px_0_rgba(255,255,255,0.45)_inset,0_14px_34px_-10px_rgba(69,208,196,0.8)]',
  outline: 'text-accent shadow-[0_0_0_1px_rgba(69,208,196,0.55)] hover:bg-accent/10 hover:shadow-[0_0_0_1px_rgba(69,208,196,0.85)]',
  accent: 'bg-accent/12 text-accent shadow-[0_0_0_1px_rgba(69,208,196,0.4)] hover:bg-accent/20 hover:shadow-[0_0_0_1px_rgba(69,208,196,0.65)]',
  secondary: 'bg-raised text-ink shadow-[0_0_0_1px_rgba(255,255,255,0.1)] hover:bg-hover hover:shadow-[0_0_0_1px_rgba(255,255,255,0.18),0_8px_18px_-10px_rgba(0,0,0,0.8)] hover:-translate-y-px',
  ghost: 'text-ink-2 hover:text-ink hover:bg-hover',
};
const SIZE: Record<Size, string> = {
  sm: 'h-7 gap-1.5 px-2.5 text-[11.5px] rounded-sm',
  md: 'h-9 gap-2 px-3.5 text-[12.5px] rounded-md',
  lg: 'h-11 gap-2.5 px-5 text-[13.5px] rounded-md',
};

/** The button look, for links that must stay links (e.g. `<a download>`). */
export const buttonClass = (variant: Variant = 'secondary', size: Size = 'md', block = false) =>
  `tt-press inline-flex select-none items-center justify-center whitespace-nowrap font-medium disabled:opacity-40 ${VARIANT[variant]} ${SIZE[size]} ${block ? 'w-full' : ''}`;

export interface TerratraceButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: Variant;
  size?: Size;
  icon?: ReactNode;
  trailing?: ReactNode;
  block?: boolean;
}

/** TerratraceButton — physical press, hover lift (secondary), visible focus ring. */
export const Button = forwardRef<HTMLButtonElement, TerratraceButtonProps>(function Button(
  { variant = 'secondary', size = 'md', icon, trailing, block, className = '', children, ...rest },
  ref,
) {
  return (
    <button
      ref={ref}
      className={`${buttonClass(variant, size, block)} ${className}`}
      {...rest}
    >
      {icon && <span className="-ml-0.5 inline-flex shrink-0">{icon}</span>}
      {children}
      {trailing && <span className="-mr-0.5 inline-flex shrink-0">{trailing}</span>}
    </button>
  );
});

interface IconButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  label: string;
  size?: Size;
  active?: boolean;
  variant?: 'ghost' | 'secondary';
}

const ICON_SIZE: Record<Size, string> = { sm: 'h-7 w-7 rounded-sm', md: 'h-9 w-9 rounded-md', lg: 'h-11 w-11 rounded-md' };

/** Square icon control; `active` marks toggled state (aria-pressed). */
export const IconButton = forwardRef<HTMLButtonElement, IconButtonProps>(function IconButton(
  { label, size = 'md', active, variant = 'ghost', className = '', children, ...rest },
  ref,
) {
  const base =
    variant === 'secondary'
      ? 'bg-raised text-ink-2 shadow-[0_0_0_1px_rgba(255,255,255,0.1)] hover:bg-hover hover:text-ink'
      : 'text-ink-2 hover:bg-hover hover:text-ink';
  const on = 'bg-accent/12 !text-accent shadow-[0_0_0_1px_rgba(69,208,196,0.4)]';
  return (
    <button
      ref={ref}
      aria-label={label}
      title={rest.title}
      aria-pressed={active}
      className={`tt-press inline-grid shrink-0 place-items-center disabled:opacity-35 ${ICON_SIZE[size]} ${base} ${active ? on : ''} ${className}`}
      {...rest}
    >
      {children}
    </button>
  );
});
