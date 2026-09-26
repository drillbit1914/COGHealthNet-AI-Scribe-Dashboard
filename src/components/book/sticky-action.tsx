/** Bottom-anchored primary action within thumb reach on phones. */
export function StickyAction({ children }: { children: React.ReactNode }) {
  return (
    <div className="border-line bg-paper/95 sticky bottom-0 -mx-4 mt-auto border-t px-4 pt-3 pb-[max(1rem,env(safe-area-inset-bottom))] backdrop-blur">
      <div className="flex flex-col gap-2">{children}</div>
    </div>
  );
}
