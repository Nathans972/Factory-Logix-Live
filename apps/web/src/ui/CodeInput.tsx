/**
 * Four-digit pairing-code entry rendered as one box per digit
 * (docs/design/admin-displays.html, the "Claim a TV" drawer).
 *
 * One `<input>` per box with auto-advance, backspace-to-previous, arrow keys and paste
 * support (pasting "7318" anywhere fills every box).
 */
import { useEffect, useRef, type ClipboardEvent, type KeyboardEvent } from 'react';

export function CodeInput({
  value,
  onChange,
  length = 4,
  autoFocus,
  invalid,
  id,
}: {
  /** current value, 0…`length` digits */
  value: string;
  onChange: (v: string) => void;
  length?: number;
  autoFocus?: boolean;
  invalid?: boolean;
  id?: string;
}) {
  const refs = useRef<(HTMLInputElement | null)[]>([]);

  useEffect(() => {
    if (autoFocus) refs.current[0]?.focus();
  }, [autoFocus]);

  const digits = value.replace(/\D/g, '').slice(0, length);
  const focus = (i: number) => {
    const el = refs.current[Math.max(0, Math.min(length - 1, i))];
    el?.focus();
    el?.select();
  };

  const setDigit = (i: number, d: string) => {
    const next = digits.padEnd(length, ' ').split('');
    next[i] = d || ' ';
    onChange(next.join('').replace(/ /g, '').slice(0, length));
  };

  const onKeyDown = (i: number) => (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'Backspace') {
      e.preventDefault();
      if (digits[i]) setDigit(i, '');
      else if (i > 0) {
        const next = digits.slice(0, i - 1);
        onChange(next);
        focus(i - 1);
      }
      return;
    }
    if (e.key === 'ArrowLeft') {
      e.preventDefault();
      focus(i - 1);
      return;
    }
    if (e.key === 'ArrowRight') {
      e.preventDefault();
      focus(i + 1);
      return;
    }
    if (/^\d$/.test(e.key)) {
      e.preventDefault();
      const next = (digits.slice(0, i) + e.key).slice(0, length);
      onChange(next);
      focus(i + 1);
    }
  };

  const onPaste = (e: ClipboardEvent<HTMLInputElement>) => {
    const text = e.clipboardData.getData('text').replace(/\D/g, '').slice(0, length);
    if (!text) return;
    e.preventDefault();
    onChange(text);
    focus(text.length);
  };

  return (
    <div className={`code-boxes${invalid ? ' invalid' : ''}`} id={id}>
      {Array.from({ length }, (_, i) => (
        <input
          key={i}
          ref={(el) => {
            refs.current[i] = el;
          }}
          className="code-box"
          inputMode="numeric"
          autoComplete="off"
          aria-label={`Digit ${i + 1} of ${length}`}
          maxLength={1}
          value={digits[i] ?? ''}
          onKeyDown={onKeyDown(i)}
          onPaste={onPaste}
          onFocus={(e) => e.currentTarget.select()}
          onChange={() => undefined}
        />
      ))}
    </div>
  );
}
