"use client";

import { CopyIconButton } from "@/components/copy-icon-button";
import { FieldHint } from "@/components/ui/field";

// The Settings page's read-only "Moodle connection" section, rendered for
// effective teachers only (docs/moodle.md). The connection is server
// configuration: this section only hands out what the Moodle administrator
// needs (Novedu's three addresses and its public key) and says whether the
// connection values from Moodle are set. Nothing here is editable.

export type MoodleConnectionView =
  | { state: "no-key" }
  | {
      state: "key";
      /** Moodle's Plattform-ID when the connection is complete, else `null`. */
      connectedTo: string | null;
      toolUrl: string;
      loginUrl: string;
      jwksUrl: string;
      publicKeyPem: string;
    };

export function MoodleConnection({ view }: { view: MoodleConnectionView }) {
  if (view.state === "no-key") {
    return (
      <p className="text-foreground/70 text-sm">
        Moodle hand-in is not set up on this Novedu (no key configured).
      </p>
    );
  }

  return (
    <div className="flex flex-col gap-4">
      <p className="text-sm" data-testid="moodle-connection-state">
        {view.connectedTo ? (
          <>
            Connected to <span className="font-mono">{view.connectedTo}</span>.
          </>
        ) : (
          "Not connected yet. The values from Moodle (Plattform-ID, Client-ID, Deployment-ID) must be set on the server."
        )}
      </p>
      <div className="flex flex-col gap-2">
        <h3 className="font-medium text-sm">Give these to your Moodle administrator</h3>
        <AddressRow label="Tool URL and redirect URI" value={view.toolUrl} />
        <AddressRow label="Login URL" value={view.loginUrl} />
        <AddressRow label="Key set URL" value={view.jwksUrl} />
        <div className="flex flex-col gap-1">
          <div className="flex items-center justify-between gap-2">
            <span className="text-foreground/70 text-xs">
              Public key (for the "RSA key" variant)
            </span>
            <CopyIconButton text={view.publicKeyPem} label="Copy public key" />
          </div>
          <pre className="overflow-x-auto rounded-md border border-foreground/15 bg-foreground/5 p-2 font-mono text-xs">
            {view.publicKeyPem}
          </pre>
        </div>
      </div>
      <FieldHint>
        Your Moodle administrator must set "Anwendername an Tool übergeben" to "Immer". Without the
        name, students can't link their accounts.
      </FieldHint>
    </div>
  );
}

function AddressRow({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex flex-col gap-0.5">
      <span className="text-foreground/70 text-xs">{label}</span>
      <div className="flex items-center gap-2">
        <code className="min-w-0 flex-1 break-all font-mono text-sm">{value}</code>
        <CopyIconButton text={value} label={`Copy ${label}`} />
      </div>
    </div>
  );
}
