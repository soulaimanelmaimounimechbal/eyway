import { cn } from "@/lib/utils";

interface ProgressDotsProps {
  step: number;
  total: number;
  label?: string;
}

export function ProgressDots({ step, total, label }: ProgressDotsProps) {
  return (
    <div className="flex items-center gap-3" data-testid="progress-dots">
      <div className="flex items-center gap-1.5">
        {Array.from({ length: total }).map((_, i) => (
          <div
            key={i}
            className={cn(
              "h-1.5 rounded-full transition-all",
              i < step ? "w-6 bg-primary" : i === step ? "w-8 bg-primary" : "w-3 bg-border",
            )}
          />
        ))}
      </div>
      {label ? (
        <span className="text-xs uppercase tracking-wider text-muted-foreground">{label}</span>
      ) : null}
    </div>
  );
}
