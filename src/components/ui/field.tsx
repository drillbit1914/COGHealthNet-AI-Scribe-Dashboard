import * as React from 'react';
import { cn } from '@/lib/utils';

export function Label({ className, ...p }: React.LabelHTMLAttributes<HTMLLabelElement>) {
  return <label className={cn('mb-1 block font-bold', className)} {...p} />;
}

export const inputClass =
  'block w-full rounded-xl border-2 border-line bg-white px-4 py-3 text-lg text-ink placeholder:text-muted focus:border-jacaranda focus:outline-none aria-invalid:border-laterite';

export function Input({ className, ...p }: React.InputHTMLAttributes<HTMLInputElement>) {
  return <input className={cn(inputClass, className)} {...p} />;
}

export function Textarea({ className, ...p }: React.TextareaHTMLAttributes<HTMLTextAreaElement>) {
  return <textarea className={cn(inputClass, 'min-h-32', className)} {...p} />;
}

export function Help({ className, ...p }: React.HTMLAttributes<HTMLParagraphElement>) {
  return <p className={cn('text-muted mt-1 text-sm', className)} {...p} />;
}

/** Large tappable option (radio or checkbox) — one decision per screen, thumb-friendly. */
export function Choice({
  type = 'radio',
  label,
  help,
  className,
  ...p
}: React.InputHTMLAttributes<HTMLInputElement> & { label: React.ReactNode; help?: React.ReactNode }) {
  return (
    <label
      className={cn(
        'border-line has-[:checked]:border-jacaranda has-[:checked]:bg-jacaranda-light flex cursor-pointer items-start gap-3 rounded-xl border-2 bg-white p-4',
        className,
      )}
    >
      <input type={type} className="accent-jacaranda mt-1 size-5" {...p} />
      <span>
        <span className="block font-bold">{label}</span>
        {help && <span className="text-muted block text-sm">{help}</span>}
      </span>
    </label>
  );
}

export function Alert({
  tone = 'info',
  className,
  ...p
}: React.HTMLAttributes<HTMLDivElement> & { tone?: 'info' | 'error' | 'success' | 'warning' }) {
  const tones = {
    info: 'border-jacaranda bg-jacaranda-light',
    error: 'border-laterite bg-[#fbeeeb] text-laterite',
    success: 'border-acacia bg-[#eaf4ee]',
    warning: 'border-sunbird bg-[#fdf5e6]',
  };
  return (
    <div
      role={tone === 'error' ? 'alert' : 'status'}
      className={cn('rounded-xl border-l-4 p-4', tones[tone], className)}
      {...p}
    />
  );
}

export function Card({ className, ...p }: React.HTMLAttributes<HTMLDivElement>) {
  return <div className={cn('border-line rounded-2xl border bg-white p-4 shadow-sm', className)} {...p} />;
}

const badgeTones: Record<string, string> = {
  CONFIRMED: 'bg-acacia text-white',
  COMPLETED: 'bg-acacia text-white',
  REQUESTED: 'bg-sunbird text-ink',
  ALTERNATE_PROPOSED: 'bg-sunbird text-ink',
};
export function StatusBadge({ status, label }: { status: string; label: string }) {
  return (
    <span
      className={cn(
        'inline-block rounded-full px-3 py-1 text-sm font-bold',
        badgeTones[status] ?? 'bg-laterite text-white',
      )}
    >
      {label}
    </span>
  );
}
