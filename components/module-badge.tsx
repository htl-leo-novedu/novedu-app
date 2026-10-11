import type { ReactNode } from "react";
import { CodeIcon, EditIcon, FlagIcon, HelpCircleIcon, TextGapIcon } from "@/components/icons";
import { Badge } from "@/components/ui/badge";
import { type CodeModule, codeModuleLabels } from "@/lib/code-modules/types";

// A code's kind as the teacher pages show it: the solid, uppercase module pill in
// the module's identity tone, with its tiny icon (decorative — the text is the
// label). Shared by the Codes list and the teacher start page. Server-safe.

const MODULE_ICONS: Record<CodeModule, ReactNode> = {
  tutor: <FlagIcon className="size-3" />,
  quiz: <HelpCircleIcon className="size-3" />,
  writing: <EditIcon className="size-3" />,
  coding: <CodeIcon className="size-3" />,
  cloze: <TextGapIcon className="size-3" />,
};

export function ModuleBadge({ module }: { module: CodeModule }) {
  return (
    <Badge tone={codeModuleLabels[module].tone} solid caps>
      {MODULE_ICONS[module]}
      {codeModuleLabels[module].badge}
    </Badge>
  );
}
