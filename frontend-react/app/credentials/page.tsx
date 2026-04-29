"use client";

import { useState } from "react";
import {
  Plus, Trash2, ChevronDown, Loader2,
  KeyRound, Eye, EyeOff, Pencil, X, Save,
} from "lucide-react";
import {
  useCredentials, useCreateCredential, useDeleteCredential,
  useUpdateCredential, useDevices, getErrorMessage,
} from "@/hooks/useNetPulse";
import type { Credential } from "@/lib/types";
import { Button, EmptyState, FormField, Input, Spinner } from "@/components/ui";
import { cn } from "@/lib/utils";

const AUTH_TYPES = ["ssh", "snmp", "api", "http"] as const;

// ---------------------------------------------------------------------------
// Sdílený formulář
// ---------------------------------------------------------------------------
function CredentialForm({ initial, onSave, onCancel, isPending, isEdit = false }: {
  initial?:  Partial<Credential>;
  onSave:    (data: any) => Promise<void>;
  onCancel:  () => void;
  isPending: boolean;
  isEdit?:   boolean;
}) {
  const [name,        setName]        = useState(initial?.name      ?? "");
  const [authType,    setAuthType]    = useState<typeof AUTH_TYPES[number]>((initial?.auth_type as typeof AUTH_TYPES[number]) ?? "api");
  const [username,    setUsername]    = useState(initial?.username  ?? "");
  const [password,    setPassword]    = useState("");
  const [port,        setPort]        = useState<number>(initial?.port ?? 0);
  const [snmpVersion, setSnmpVersion] = useState("2c");
  const [showPw,      setShowPw]      = useState(false);
  const [error,       setError]       = useState<string | null>(null);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    if (!name.trim()) { setError("Název profilu je povinný"); return; }
    if (!isEdit && !password.trim()) { setError("Heslo je povinné"); return; }
    try {
      await onSave({
        name: name.trim(), auth_type: authType,
        username: username.trim(), password,
        port, extra_params: authType === "snmp" ? { snmp_version: snmpVersion } : {},
      });
    } catch (err) { setError(getErrorMessage(err)); }
  }

  return (
    <form onSubmit={handleSubmit} className="space-y-4">
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
        <FormField label="Název profilu *">
          <Input value={name} onChange={(e) => setName(e.target.value)}
                 placeholder="SSH-admin-sklad" autoComplete="off" />
        </FormField>
        <FormField label="Typ autentizace">
          <select value={authType} onChange={(e) => setAuthType(e.target.value as typeof AUTH_TYPES[number])}
                  className="h-9 w-full rounded-md border border-border bg-background
                             px-3 text-sm focus:outline-none focus:ring-2 focus:ring-primary/50">
            {AUTH_TYPES.map((t) => <option key={t} value={t}>{t.toUpperCase()}</option>)}
          </select>
        </FormField>
        <FormField label="Uživatelské jméno">
          <Input value={username} onChange={(e) => setUsername(e.target.value)}
                 placeholder="admin" autoComplete="off" />
        </FormField>
        <FormField label={isEdit ? "Nové heslo (prázdné = zachovat)" : "Heslo *"}>
          <div className="relative">
            <Input type={showPw ? "text" : "password"} value={password}
                   onChange={(e) => setPassword(e.target.value)}
                   placeholder={isEdit ? "Ponechat stávající…" : "••••••••"}
                   className="pr-9" autoComplete="new-password" />
            <button type="button" onClick={() => setShowPw(v => !v)}
                    className="absolute right-2.5 top-1/2 -translate-y-1/2
                               text-muted-foreground hover:text-foreground">
              {showPw ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}
            </button>
          </div>
        </FormField>
        <FormField label="Port (0 = výchozí)">
          <input type="number" min={0} max={65535} value={port}
                 onChange={(e) => setPort(parseInt(e.target.value) || 0)}
                 className="h-9 w-full rounded-md border border-border bg-background
                            px-3 text-sm focus:outline-none focus:ring-2 focus:ring-primary/50" />
        </FormField>
        {authType === "snmp" && (
          <FormField label="SNMP verze">
            <select value={snmpVersion} onChange={(e) => setSnmpVersion(e.target.value)}
                    className="h-9 w-full rounded-md border border-border bg-background
                               px-3 text-sm focus:outline-none focus:ring-2 focus:ring-primary/50">
              <option value="2c">2c</option>
              <option value="3">3</option>
            </select>
          </FormField>
        )}
      </div>
      {!isEdit && (
        <p className="text-xs text-muted-foreground">
          🔒 Heslo je šifrováno Fernet AES-128. Nikdy se neposílá zpět klientovi.
        </p>
      )}
      {error && (
        <div className="rounded-md bg-destructive/10 px-3 py-2 text-sm text-destructive">
          {error}
        </div>
      )}
      <div className="flex gap-2">
        <Button type="submit" variant="primary" size="sm" disabled={isPending}>
          {isPending ? <Loader2 className="h-3.5 w-3.5 animate-spin" />
            : isEdit ? <Save className="h-3.5 w-3.5" />
            : <Plus className="h-3.5 w-3.5" />}
          {isEdit ? "Uložit změny" : "Uložit profil"}
        </Button>
        <Button type="button" size="sm" variant="ghost" onClick={onCancel}>
          <X className="h-3.5 w-3.5" /> Zrušit
        </Button>
      </div>
    </form>
  );
}

// ---------------------------------------------------------------------------
// Řádek credentialu
// ---------------------------------------------------------------------------
function CredentialRow({ cred, usedByDevices }: {
  cred: Credential; usedByDevices: string[];
}) {
  const [confirming, setConfirming] = useState(false);
  const [editing,    setEditing]    = useState(false);
  const deleteCred = useDeleteCredential();
  const updateCred = useUpdateCredential();

  const authColors: Record<string, string> = {
    ssh:  "bg-blue-50 text-blue-700 dark:bg-blue-950 dark:text-blue-300",
    snmp: "bg-purple-50 text-purple-700 dark:bg-purple-950 dark:text-purple-300",
    api:  "bg-green-50 text-green-700 dark:bg-green-950 dark:text-green-300",
    http: "bg-amber-50 text-amber-700 dark:bg-amber-950 dark:text-amber-300",
  };

  return (
    <div className="rounded-lg border border-border bg-card overflow-hidden">
      <div className="flex items-center gap-3 px-4 py-3">
        <KeyRound className="h-4 w-4 shrink-0 text-muted-foreground" />
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2 flex-wrap">
            <p className="font-medium">{cred.name}</p>
            <span className={cn(
              "rounded-full px-2 py-0.5 text-xs font-medium",
              authColors[cred.auth_type] ?? "bg-muted text-muted-foreground"
            )}>
              {cred.auth_type.toUpperCase()}
            </span>
            {cred.username && (
              <span className="text-xs text-muted-foreground">👤 {cred.username}</span>
            )}
            {cred.port ? (
              <span className="text-xs text-muted-foreground">:{cred.port}</span>
            ) : null}
          </div>
          {usedByDevices.length > 0 && (
            <p className="mt-0.5 text-xs text-muted-foreground">
              Přiřazeno: {usedByDevices.join(", ")}
            </p>
          )}
        </div>

        {!confirming && !editing && (
          <div className="flex items-center gap-1 shrink-0">
            <Button size="icon" variant="ghost"
                    onClick={() => setEditing(true)}>
              <Pencil className="h-3.5 w-3.5" />
            </Button>
            <Button size="icon" variant="ghost"
                    onClick={() => setConfirming(true)}
                    className="text-destructive hover:text-destructive">
              <Trash2 className="h-3.5 w-3.5" />
            </Button>
          </div>
        )}
        {confirming && (
          <div className="flex items-center gap-2 shrink-0">
            <span className="text-xs text-destructive">Smazat?</span>
            <Button size="sm" variant="destructive" disabled={deleteCred.isPending}
                    onClick={() => deleteCred.mutate(cred.id)}>
              {deleteCred.isPending ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : "Ano"}
            </Button>
            <Button size="sm" variant="ghost" onClick={() => setConfirming(false)}>Ne</Button>
          </div>
        )}
      </div>

      {editing && (
        <div className="border-t border-border bg-muted/10 px-4 py-4">
          <p className="text-xs font-medium text-muted-foreground mb-3">
            Upravit profil <strong>{cred.name}</strong>
          </p>
          <CredentialForm
            isEdit initial={cred}
            isPending={updateCred.isPending}
            onCancel={() => setEditing(false)}
            onSave={async (data) => {
              await updateCred.mutateAsync({ id: cred.id, data });
              setEditing(false);
            }}
          />
        </div>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Hlavní stránka
// ---------------------------------------------------------------------------
export default function CredentialsPage() {
  const { data: creds = [], isLoading } = useCredentials();
  const { data: devices = [] }          = useDevices();
  const createCred = useCreateCredential();
  const [showAdd, setShowAdd] = useState(false);

  const credUsage = devices.reduce<Record<number, string[]>>((acc, d) => {
    for (const c of d.credentials) {
      if (!acc[c.id]) acc[c.id] = [];
      acc[c.id].push(d.alias ?? d.hostname);
    }
    return acc;
  }, {});

  return (
    <div className="space-y-4">
      <div className="rounded-lg border border-border bg-card">
        <button onClick={() => setShowAdd(v => !v)}
                className="flex w-full items-center gap-2 px-4 py-3 text-sm font-medium
                           hover:bg-muted/40 transition-colors rounded-lg">
          <Plus className="h-4 w-4 text-primary" />
          Přidat přihlašovací profil
          <div className="flex-1" />
          <ChevronDown className={cn(
            "h-4 w-4 text-muted-foreground transition-transform duration-150",
            showAdd && "rotate-180"
          )} />
        </button>
        {showAdd && (
          <div className="border-t border-border p-4">
            <CredentialForm
              isPending={createCred.isPending}
              onCancel={() => setShowAdd(false)}
              onSave={async (data) => {
                await createCred.mutateAsync(data);
                setShowAdd(false);
              }}
            />
          </div>
        )}
      </div>

      {isLoading ? (
        <div className="flex h-32 items-center justify-center"><Spinner className="h-6 w-6" /></div>
      ) : creds.length === 0 ? (
        <EmptyState icon={KeyRound} title="Žádné přihlašovací profily"
          description="Přidejte SSH, SNMP nebo API profil pro přístup k zařízením." />
      ) : (
        <div className="space-y-2">
          <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
            Profily ({creds.length})
          </p>
          {creds.map((c) => (
            <CredentialRow key={c.id} cred={c} usedByDevices={credUsage[c.id] ?? []} />
          ))}
        </div>
      )}
    </div>
  );
}
