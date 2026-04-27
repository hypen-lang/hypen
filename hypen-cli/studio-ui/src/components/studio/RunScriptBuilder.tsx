/**
 * Modal for composing or editing a custom run script.
 *
 * Kept intentionally humble — each step is one row with a type picker plus
 * the type's fields, and an ordered list with ↑/↓/× buttons. Drag-to-reorder
 * would be nicer but needs @dnd-kit; buttons are fine for V1.
 *
 * `onSave` receives the full edited script. Persistence (write to
 * hypen.json) happens in the parent so this component stays pure.
 */
import { useState, useCallback } from "react";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import {
  X,
  Plus,
  ArrowUp,
  ArrowDown,
  Trash2,
} from "lucide-react";
import {
  type RunScript,
  type Step,
  type Platform,
  defaultStep,
  STEP_KINDS,
} from "./run-scripts-types";

interface BuilderProps {
  initial: RunScript;
  onSave: (script: RunScript) => void;
  onCancel: () => void;
}

export function RunScriptBuilder({ initial, onSave, onCancel }: BuilderProps) {
  const [draft, setDraft] = useState<RunScript>(() => ({ ...initial, steps: [...initial.steps] }));

  const setStep = useCallback((i: number, next: Step) => {
    setDraft((d) => {
      const steps = [...d.steps];
      steps[i] = next;
      return { ...d, steps };
    });
  }, []);

  const moveStep = useCallback((i: number, delta: number) => {
    setDraft((d) => {
      const j = i + delta;
      if (j < 0 || j >= d.steps.length) return d;
      const steps = [...d.steps];
      const tmp = steps[i];
      steps[i] = steps[j];
      steps[j] = tmp;
      return { ...d, steps };
    });
  }, []);

  const removeStep = useCallback((i: number) => {
    setDraft((d) => ({ ...d, steps: d.steps.filter((_, j) => j !== i) }));
  }, []);

  const addStep = useCallback(() => {
    setDraft((d) => ({ ...d, steps: [...d.steps, defaultStep("shell")] }));
  }, []);

  const canSave = draft.name.trim().length > 0 && draft.steps.length > 0;

  return (
    <div
      className="fixed inset-0 z-[60] bg-black/60 flex items-center justify-center p-4"
      onClick={onCancel}
    >
      <div
        className="w-[640px] max-w-full max-h-[85vh] rounded-lg border border-border bg-popover shadow-xl flex flex-col"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center gap-2 px-4 py-3 border-b border-border">
          <span className="text-sm font-mono font-medium">
            {initial.id === draft.id && initial.name === draft.name && draft.steps === initial.steps ? "Edit script" : initial.name === "New script" ? "New script" : "Edit script"}
          </span>
          <div className="flex-1" />
          <Button variant="ghost" size="sm" onClick={onCancel} className="h-7 w-7 p-0" title="Close">
            <X className="w-4 h-4" />
          </Button>
        </div>

        <div className="flex-1 overflow-y-auto p-4 space-y-4">
          {/* Name */}
          <label className="block">
            <span className="text-[11px] uppercase tracking-wider text-muted-foreground">Name</span>
            <input
              type="text"
              value={draft.name}
              onChange={(e) => setDraft((d) => ({ ...d, name: e.target.value }))}
              className="mt-1 w-full h-8 px-2.5 rounded-md bg-muted/40 border border-border text-xs font-mono focus:outline-none focus:ring-1 focus:ring-[#FFA7E1]/50"
              placeholder="Gallery Test"
            />
          </label>

          {/* Steps */}
          <div>
            <div className="text-[11px] uppercase tracking-wider text-muted-foreground mb-2">Steps</div>
            <div className="space-y-2">
              {draft.steps.map((step, i) => (
                <StepEditor
                  key={i}
                  index={i}
                  step={step}
                  totalSteps={draft.steps.length}
                  onChange={(s) => setStep(i, s)}
                  onMoveUp={() => moveStep(i, -1)}
                  onMoveDown={() => moveStep(i, 1)}
                  onRemove={() => removeStep(i)}
                />
              ))}
            </div>
            <Button
              variant="ghost"
              size="sm"
              className="mt-2 gap-1.5 text-xs"
              onClick={addStep}
            >
              <Plus className="w-3 h-3" /> Add step
            </Button>
          </div>
        </div>

        <div className="flex items-center justify-end gap-2 px-4 py-3 border-t border-border">
          <Button variant="ghost" size="sm" onClick={onCancel}>Cancel</Button>
          <Button
            variant="outline"
            size="sm"
            onClick={() => onSave(draft)}
            disabled={!canSave}
          >
            Save
          </Button>
        </div>
      </div>
    </div>
  );
}

// ─── Per-step editor ───────────────────────────────────────────────────

interface StepEditorProps {
  index: number;
  step: Step;
  totalSteps: number;
  onChange: (s: Step) => void;
  onMoveUp: () => void;
  onMoveDown: () => void;
  onRemove: () => void;
}

function StepEditor({ index, step, totalSteps, onChange, onMoveUp, onMoveDown, onRemove }: StepEditorProps) {
  const setKind = (kind: Step["type"]) => onChange(defaultStep(kind));

  return (
    <div className="rounded-md border border-border bg-muted/20 p-2.5 space-y-2">
      <div className="flex items-center gap-2">
        <span className="text-[10px] font-mono text-muted-foreground w-5">{index + 1}.</span>
        <select
          value={step.type}
          onChange={(e) => setKind(e.target.value as Step["type"])}
          className="h-7 px-2 rounded-md bg-background border border-border text-xs font-mono focus:outline-none focus:ring-1 focus:ring-[#FFA7E1]/50"
        >
          {STEP_KINDS.map((k) => (
            <option key={k} value={k}>{k}</option>
          ))}
        </select>
        <div className="flex-1" />
        <IconBtn onClick={onMoveUp} disabled={index === 0} title="Move up">
          <ArrowUp className="w-3 h-3" />
        </IconBtn>
        <IconBtn onClick={onMoveDown} disabled={index === totalSteps - 1} title="Move down">
          <ArrowDown className="w-3 h-3" />
        </IconBtn>
        <IconBtn onClick={onRemove} title="Remove">
          <Trash2 className="w-3 h-3" />
        </IconBtn>
      </div>
      <StepFields step={step} onChange={onChange} />
    </div>
  );
}

function IconBtn({ children, onClick, disabled, title }: { children: React.ReactNode; onClick: () => void; disabled?: boolean; title: string }) {
  return (
    <button
      onClick={onClick}
      disabled={disabled}
      title={title}
      className={cn(
        "h-6 w-6 inline-flex items-center justify-center rounded hover:bg-muted/60 opacity-70 hover:opacity-100",
        disabled && "opacity-30 cursor-not-allowed hover:bg-transparent",
      )}
    >
      {children}
    </button>
  );
}

function StepFields({ step, onChange }: { step: Step; onChange: (s: Step) => void }) {
  switch (step.type) {
    case "install-gallery":
      return (
        <PlatformPicker
          value={step.platform}
          onChange={(platform) => onChange({ ...step, platform })}
        />
      );
    case "shell":
      return (
        <div className="space-y-2">
          <TextField
            label="Command"
            value={step.cmd}
            onChange={(cmd) => onChange({ ...step, cmd })}
            placeholder="bun run seed"
            mono
          />
          <TextField
            label="Working directory (optional)"
            value={step.cwd ?? ""}
            onChange={(cwd) => onChange({ ...step, cwd: cwd || undefined })}
            placeholder="./scripts"
            mono
          />
        </div>
      );
    case "open-in-gallery":
      return (
        <div className="space-y-2">
          <TextField
            label="URL"
            value={step.url}
            onChange={(url) => onChange({ ...step, url })}
            placeholder="localhost:5173/ws/engine"
            mono
          />
          <PlatformPicker
            value={step.platform}
            onChange={(platform) => onChange({ ...step, platform })}
          />
          <TextField
            label="Device id (optional)"
            value={step.deviceId ?? ""}
            onChange={(deviceId) => onChange({ ...step, deviceId: deviceId || undefined })}
            placeholder="emulator-5554"
            mono
          />
        </div>
      );
    case "hypen-run":
      return (
        <div className="space-y-2">
          <PlatformPicker
            value={step.platform}
            onChange={(platform) => onChange({ ...step, platform })}
          />
          <TextField
            label="URL (optional)"
            value={step.url ?? ""}
            onChange={(url) => onChange({ ...step, url: url || undefined })}
            placeholder="localhost:5173/ws/engine"
            mono
          />
        </div>
      );
  }
}

function PlatformPicker({ value, onChange }: { value: Platform; onChange: (p: Platform) => void }) {
  return (
    <label className="block">
      <span className="text-[10px] uppercase tracking-wider text-muted-foreground">Platform</span>
      <select
        value={value}
        onChange={(e) => onChange(e.target.value as Platform)}
        className="mt-1 h-7 px-2 rounded-md bg-background border border-border text-xs font-mono focus:outline-none focus:ring-1 focus:ring-[#FFA7E1]/50"
      >
        <option value="android">android</option>
        <option value="ios">ios</option>
      </select>
    </label>
  );
}

function TextField({
  label, value, onChange, placeholder, mono,
}: {
  label: string;
  value: string;
  onChange: (v: string) => void;
  placeholder?: string;
  mono?: boolean;
}) {
  return (
    <label className="block">
      <span className="text-[10px] uppercase tracking-wider text-muted-foreground">{label}</span>
      <input
        type="text"
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder={placeholder}
        className={cn(
          "mt-1 w-full h-7 px-2 rounded-md bg-background border border-border text-xs focus:outline-none focus:ring-1 focus:ring-[#FFA7E1]/50",
          mono && "font-mono",
        )}
      />
    </label>
  );
}
