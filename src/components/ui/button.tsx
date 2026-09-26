import { Slot } from '@radix-ui/react-slot';
import { cva, type VariantProps } from 'class-variance-authority';
import * as React from 'react';
import { cn } from '@/lib/utils';

const buttonVariants = cva(
  'inline-flex items-center justify-center gap-2 rounded-xl font-bold transition-colors disabled:pointer-events-none disabled:opacity-50',
  {
    variants: {
      variant: {
        primary: 'bg-jacaranda text-white hover:bg-jacaranda-dark',
        secondary: 'border-2 border-jacaranda bg-white text-jacaranda hover:bg-jacaranda-light',
        ghost: 'text-jacaranda underline-offset-4 hover:underline',
        danger: 'bg-laterite text-white hover:opacity-90',
      },
      size: { md: 'h-11 px-4 text-base', lg: 'h-14 w-full px-6 text-lg', sm: 'h-9 px-3 text-sm' },
    },
    defaultVariants: { variant: 'primary', size: 'md' },
  },
);

export interface ButtonProps
  extends React.ButtonHTMLAttributes<HTMLButtonElement>, VariantProps<typeof buttonVariants> {
  asChild?: boolean;
}

export function Button({ className, variant, size, asChild, ...props }: ButtonProps) {
  const Comp = asChild ? Slot : 'button';
  return <Comp className={cn(buttonVariants({ variant, size }), className)} {...props} />;
}
export { buttonVariants };
