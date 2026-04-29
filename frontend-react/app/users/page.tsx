"use client";

import { useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import {
  UserPlus, Key, Eye, EyeOff, Copy, Check,
  Loader2, ShieldCheck, Shield, Pencil, Trash2,
  Save, X, ChevronDown, ToggleLeft, ToggleRight,
} from "lucide-react";
import api, { authApi, getErrorMessage } from "@/lib/api";
import type { User } from "@/lib/types";
import { Button, FormField, Input, Spinner, Badge } from "@/components/ui";
import { cn, formatDateTime } from "@/lib/utils";

// ---------------------------------------------------------------------------
// Typy
// ---------------------------------------------------------------------------
interface UserFull extends User {
  email:      string | null;
  active:     boolean;
  created_at: string;
}

interface ApiKey {
  id:          number;
  description: string;
  created_at:  string;
  last_used:   string | null;
  active:      boolean;
}

// ---------------------------------------------------------------------------
// API volání
// ---------------------------------------------------------------------------
const usersApi = {
  getAll:    ()                          => api.get<UserFull[]>("/auth/users").then(r => r.data),
  update:    (id: number, data: object)  => api.put<UserFull>(`/auth/users/${id}`, data).then(r => r.data),
  delete:    (id: number)               => api.delete(`/auth/users/${id}`).then(r => r.data),
  getKeys:   (id: number)               => api.get<ApiKey[]>(`/auth/users/${id}/api-keys`).then(r => r.data),
  deleteKey: (keyId: number)            => api.delete(`/auth/api-keys/${keyId}`).then(r => r.data),
};

// ---------------------------------------------------------------------------
// Kopírovat do schránky
// ---------------------------------------------------------------------------
function CopyButton({ text }: { text: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <button onClick={async () => {
      await navigator.clipboard.writeText(text);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    }}
      className="flex items-center gap-1 rounded px-2 py-1 text-xs
                 text-muted-foreground hover:text-foreground hover:bg-muted transition-colors"
    >
      {copied ? <Check className="h-3.5 w-3.5 text-green-500" /> : <Copy className="h-3.5 w-3.5" />}
      {copied ? "Zkopírováno" : "Kopírovat"}
    </button>
  );
}

// ---------------------------------------------------------------------------
// Inline editace uživatele
// ---------------------------------------------------------------------------
function EditUserPanel({ user, onClose }: { user: UserFull; onClose: () => void }) {
  const qc = useQueryClient();
  const [role,        setRole]        = useState(user.role);
  const [email,       setEmail]       = useState(user.email ?? "");
  const [active,      setActive]      = useState(user.active);
  const [newPassword, setNewPassword] = useState("");
  const [showPw,      setShowPw]      = useState(false);
  const [confirmDel,  setConfirmDel]  = useState(false);
  const [tab,         setTab]         = useState<"info" | "keys">("info");

  const { data: keys = [], isLoading: keysLoading } = useQuery({
    queryKey: ["user-keys", user.id],
    queryFn:  () => usersApi.getKeys(user.id),
    enabled:  tab === "keys",
  });

  const updateUser = useMutation({
    mutationFn: (data: object) => usersApi.update(user.id, data),
    onSuccess: () => { qc.invalidateQueries({ queryKey: ["users"] }); },
  });

  const deleteUser = useMutation({
    mutationFn: () => usersApi.delete(user.id),
    onSuccess: () => { qc.invalidateQueries({ queryKey: ["users"] }); onClose(); },
  });

  const deleteKey = useMutation({
    mutationFn: (keyId: number) => usersApi.deleteKey(keyId),
    onSuccess: () => { qc.invalidateQueries({ queryKey: ["user-keys", user.id] }); },
  });

  async function handleSave() {
    const data: Record<string, unknown> = { role, email: email || null, active };
    if (newPassword) {
      if (newPassword.length < 8) { alert("Heslo musí mít alespoň 8 znaků"); return; }
      data.new_password = newPassword;
    }
    try {
      await updateUser.mutateAsync(data);
      setNewPassword("");
    } catch (err) { alert(getErrorMessage(err)); }
  }

  return (
    <div className="border-l-4 border-primary bg-background">
      {/* Záložky */}
      <div className="flex border-b border-border">
        {[
          { id: "info", label: "📝 Údaje" },
          { id: "keys", label: "🔑 API klíče" },
        ].map((t) => (
          <button key={t.id}
            onClick={() => setTab(t.id as "info" | "keys")}
            className={cn(
              "px-4 py-2.5 text-sm transition-colors",
              tab === t.id
                ? "border-b-2 border-primary font-medium text-foreground"
                : "text-muted-foreground hover:text-foreground"
            )}
          >
            {t.label}
          </button>
        ))}
      </div>

      {/* Tab: Základní údaje */}
      {tab === "info" && (
        <div className="p-4 space-y-4">
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
            {/* Email */}
            <FormField label="Email">
              <Input
                type="email"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                placeholder="uzivatel@example.com"
              />
            </FormField>

            {/* Role */}
            <FormField label="Role">
              <div className="flex gap-2">
                {(["viewer", "admin"] as const).map((r) => (
                  <button key={r} onClick={() => setRole(r)}
                    className={cn(
                      "flex flex-1 items-center justify-center gap-1.5 rounded-md border px-3 py-2 text-sm transition-colors",
                      role === r
                        ? "border-primary bg-primary/10 text-primary font-medium"
                        : "border-border text-muted-foreground hover:bg-muted"
                    )}
                  >
                    {r === "admin"
                      ? <ShieldCheck className="h-3.5 w-3.5" />
                      : <Shield className="h-3.5 w-3.5" />}
                    {r}
                  </button>
                ))}
              </div>
            </FormField>

            {/* Nové heslo */}
            <FormField label="Nové heslo (ponech prázdné pro beze změny)">
              <div className="relative">
                <Input
                  type={showPw ? "text" : "password"}
                  value={newPassword}
                  onChange={(e) => setNewPassword(e.target.value)}
                  placeholder="min. 8 znaků"
                  className="pr-9"
                />
                <button type="button" onClick={() => setShowPw(v => !v)}
                  className="absolute right-2.5 top-1/2 -translate-y-1/2
                             text-muted-foreground hover:text-foreground transition-colors"
                >
                  {showPw ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}
                </button>
              </div>
            </FormField>

            {/* Aktivní */}
            <FormField label="Stav účtu">
              <button onClick={() => setActive(v => !v)}
                className="flex items-center gap-2 rounded-md border border-border
                           px-3 py-2 text-sm hover:bg-muted transition-colors"
              >
                {active
                  ? <><ToggleRight className="h-5 w-5 text-green-500" /> Aktivní</>
                  : <><ToggleLeft className="h-5 w-5 text-muted-foreground" /> Deaktivován</>}
              </button>
            </FormField>
          </div>

          {/* Readonly info */}
          <div className="grid grid-cols-3 gap-3 rounded-md bg-muted/30 p-3 text-xs">
            <div>
              <p className="text-muted-foreground">Uživatel</p>
              <p className="font-mono font-medium">{user.username}</p>
            </div>
            <div>
              <p className="text-muted-foreground">Vytvořen</p>
              <p>{formatDateTime(user.created_at)}</p>
            </div>
            <div>
              <p className="text-muted-foreground">ID</p>
              <p className="font-mono">#{user.id}</p>
            </div>
          </div>

          {/* Akce */}
          <div className="flex items-center gap-2">
            <Button variant="primary" size="sm" onClick={handleSave} disabled={updateUser.isPending}>
              {updateUser.isPending ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Save className="h-3.5 w-3.5" />}
              Uložit změny
            </Button>
            {updateUser.isSuccess && (
              <span className="text-xs text-green-600 dark:text-green-400">✓ Uloženo</span>
            )}
            <div className="flex-1" />
            {confirmDel ? (
              <>
                <span className="text-xs text-destructive">Smazat uživatele?</span>
                <Button size="sm" variant="destructive"
                  onClick={() => deleteUser.mutate()} disabled={deleteUser.isPending}>
                  {deleteUser.isPending ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : "Ano, smazat"}
                </Button>
                <Button size="sm" variant="ghost" onClick={() => setConfirmDel(false)}>Ne</Button>
              </>
            ) : (
              <Button size="sm" variant="ghost" onClick={() => setConfirmDel(true)}
                className="text-destructive hover:text-destructive">
                <Trash2 className="h-3.5 w-3.5" /> Smazat
              </Button>
            )}
          </div>
        </div>
      )}

      {/* Tab: API klíče */}
      {tab === "keys" && (
        <div className="p-4 space-y-3">
          {keysLoading ? (
            <div className="flex items-center gap-2"><Spinner /> <span className="text-sm text-muted-foreground">Načítání…</span></div>
          ) : keys.length === 0 ? (
            <p className="text-sm text-muted-foreground">Žádné API klíče.</p>
          ) : (
            keys.map((k) => (
              <div key={k.id} className={cn(
                "flex items-center gap-3 rounded-md border px-3 py-2.5",
                k.active ? "border-border" : "border-border/50 opacity-60"
              )}>
                <Key className="h-4 w-4 shrink-0 text-muted-foreground" />
                <div className="flex-1 min-w-0">
                  <p className="text-sm font-medium">{k.description}</p>
                  <p className="text-xs text-muted-foreground">
                    Vytvořen: {formatDateTime(k.created_at)}
                    {k.last_used && ` · Použit: ${formatDateTime(k.last_used)}`}
                  </p>
                </div>
                {!k.active && <Badge variant="outline">neaktivní</Badge>}
                {k.active && (
                  <Button size="sm" variant="ghost"
                    onClick={() => deleteKey.mutate(k.id)}
                    disabled={deleteKey.isPending}
                    className="text-destructive hover:text-destructive shrink-0">
                    <X className="h-3.5 w-3.5" /> Deaktivovat
                  </Button>
                )}
              </div>
            ))
          )}
        </div>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Řádek uživatele v tabulce
// ---------------------------------------------------------------------------
function UserRow({ user }: { user: UserFull }) {
  const [expanded, setExpanded] = useState(false);

  return (
    <>
      <tr
        onClick={() => setExpanded(v => !v)}
        className={cn(
          "border-b border-border cursor-pointer transition-colors hover:bg-muted/40",
          expanded && "bg-primary/5"
        )}
      >
        <td className="px-4 py-3">
          <div className="flex items-center gap-2">
            <div className={cn(
              "flex h-8 w-8 shrink-0 items-center justify-center rounded-full text-sm font-medium",
              user.role === "admin"
                ? "bg-primary/10 text-primary"
                : "bg-muted text-muted-foreground"
            )}>
              {user.username[0].toUpperCase()}
            </div>
            <div>
              <p className="font-medium text-sm">{user.username}</p>
              {user.email && <p className="text-xs text-muted-foreground">{user.email}</p>}
            </div>
          </div>
        </td>
        <td className="px-4 py-3">
          <span className={cn(
            "inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-xs font-medium",
            user.role === "admin"
              ? "bg-primary/10 text-primary"
              : "bg-muted text-muted-foreground"
          )}>
            {user.role === "admin"
              ? <ShieldCheck className="h-3 w-3" />
              : <Shield className="h-3 w-3" />}
            {user.role}
          </span>
        </td>
        <td className="px-4 py-3">
          <span className={cn(
            "inline-flex rounded-full px-2 py-0.5 text-xs font-medium",
            user.active
              ? "bg-green-50 text-green-700 dark:bg-green-950 dark:text-green-300"
              : "bg-red-50 text-red-700 dark:bg-red-950 dark:text-red-300"
          )}>
            {user.active ? "aktivní" : "deaktivován"}
          </span>
        </td>
        <td className="px-4 py-3 text-xs text-muted-foreground">
          {formatDateTime(user.created_at)}
        </td>
        <td className="px-4 py-3">
          <ChevronDown className={cn(
            "h-4 w-4 text-muted-foreground transition-transform duration-150",
            expanded && "rotate-180"
          )} />
        </td>
      </tr>
      {expanded && (
        <tr className="border-b border-border">
          <td colSpan={5} className="p-0">
            <EditUserPanel user={user} onClose={() => setExpanded(false)} />
          </td>
        </tr>
      )}
    </>
  );
}

// ---------------------------------------------------------------------------
// Formulář — nový uživatel
// ---------------------------------------------------------------------------
function CreateUserForm({ onCreated }: { onCreated: () => void }) {
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [email,    setEmail]    = useState("");
  const [role,     setRole]     = useState<"viewer" | "admin">("viewer");
  const [showPw,   setShowPw]   = useState(false);
  const [loading,  setLoading]  = useState(false);
  const [error,    setError]    = useState<string | null>(null);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!username.trim()) { setError("Vyplňte uživatelské jméno"); return; }
    if (password.length < 8) { setError("Heslo musí mít alespoň 8 znaků"); return; }
    setLoading(true); setError(null);
    try {
      await api.post("/auth/users", {
        username: username.trim(), password, role,
        email: email || undefined,
      });
      setUsername(""); setPassword(""); setEmail(""); setRole("viewer");
      onCreated();
    } catch (err) {
      setError(getErrorMessage(err));
    } finally {
      setLoading(false);
    }
  }

  return (
    <form onSubmit={handleSubmit} className="space-y-4">
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
        <FormField label="Uživatelské jméno *">
          <Input value={username} onChange={e => setUsername(e.target.value)} placeholder="jan.novak" />
        </FormField>
        <FormField label="Email">
          <Input type="email" value={email} onChange={e => setEmail(e.target.value)} placeholder="jan@firma.cz" />
        </FormField>
        <FormField label="Heslo (min. 8 znaků) *">
          <div className="relative">
            <Input type={showPw ? "text" : "password"} value={password}
              onChange={e => setPassword(e.target.value)} placeholder="••••••••" className="pr-9" />
            <button type="button" onClick={() => setShowPw(v => !v)}
              className="absolute right-2.5 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground">
              {showPw ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}
            </button>
          </div>
          {password.length > 0 && (
            <div className="mt-1 flex items-center gap-1">
              {[8, 12, 16].map((t) => (
                <div key={t} className={cn("h-1 flex-1 rounded-full",
                  password.length >= t
                    ? t === 8 ? "bg-amber-400" : t === 12 ? "bg-blue-400" : "bg-green-400"
                    : "bg-muted"
                )} />
              ))}
              <span className="ml-1 text-xs text-muted-foreground">
                {password.length < 8 ? "krátké" : password.length < 12 ? "slabé" : password.length < 16 ? "dobré" : "silné"}
              </span>
            </div>
          )}
        </FormField>
      </div>

      <FormField label="Role">
        <div className="flex gap-2">
          {(["viewer", "admin"] as const).map((r) => (
            <button key={r} type="button" onClick={() => setRole(r)}
              className={cn(
                "flex items-center gap-1.5 rounded-md border px-3 py-1.5 text-sm transition-colors",
                role === r ? "border-primary bg-primary/10 text-primary font-medium" : "border-border text-muted-foreground hover:bg-muted"
              )}>
              {r === "admin" ? <ShieldCheck className="h-3.5 w-3.5" /> : <Shield className="h-3.5 w-3.5" />}
              {r}
            </button>
          ))}
        </div>
      </FormField>

      {error && <div className="rounded-md bg-destructive/10 px-3 py-2 text-sm text-destructive">{error}</div>}

      <Button type="submit" variant="primary" size="sm" disabled={loading}>
        {loading ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <UserPlus className="h-3.5 w-3.5" />}
        Vytvořit uživatele
      </Button>
    </form>
  );
}

// ---------------------------------------------------------------------------
// Formulář — generovat API klíč
// ---------------------------------------------------------------------------
function ApiKeyForm() {
  const [description, setDescription] = useState("");
  const [loading,     setLoading]     = useState(false);
  const [apiKey,      setApiKey]      = useState<string | null>(null);
  const [error,       setError]       = useState<string | null>(null);

  async function handleGenerate(e: React.FormEvent) {
    e.preventDefault();
    if (!description.trim()) { setError("Vyplňte popis klíče"); return; }
    setLoading(true); setError(null); setApiKey(null);
    try {
      const res = await authApi.generateApiKey(description.trim());
      setApiKey(res.api_key);
      setDescription("");
    } catch (err) {
      setError(getErrorMessage(err));
    } finally {
      setLoading(false);
    }
  }

  return (
    <form onSubmit={handleGenerate} className="space-y-4">
      <FormField label="Popis klíče">
        <Input value={description} onChange={e => setDescription(e.target.value)}
          placeholder="Monitoring skript, Grafana, CI/CD…" />
      </FormField>
      {error && <div className="rounded-md bg-destructive/10 px-3 py-2 text-sm text-destructive">{error}</div>}
      <Button type="submit" variant="primary" size="sm" disabled={loading}>
        {loading ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Key className="h-3.5 w-3.5" />}
        Generovat API klíč
      </Button>
      {apiKey && (
        <div className="rounded-lg border-2 border-amber-300 bg-amber-50 p-4
                        dark:border-amber-800 dark:bg-amber-950/40 space-y-2">
          <p className="text-sm font-medium text-amber-800 dark:text-amber-300">
            ⚠️ Klíč se zobrazí pouze jednou — ulož ho!
          </p>
          <div className="flex items-center gap-2 rounded-md border border-border bg-background px-3 py-2">
            <code className="flex-1 break-all font-mono text-xs">{apiKey}</code>
            <CopyButton text={apiKey} />
          </div>
          <p className="text-xs text-amber-700 dark:text-amber-400">
            Použij hlavičku: <code className="font-mono">X-API-Key: {apiKey.slice(0, 16)}…</code>
          </p>
        </div>
      )}
    </form>
  );
}

// ---------------------------------------------------------------------------
// Sekce wrapper
// ---------------------------------------------------------------------------
function Section({ title, description, children }: {
  title: string; description?: string; children: React.ReactNode;
}) {
  return (
    <div className="rounded-lg border border-border bg-card p-6 space-y-4">
      <div>
        <h2 className="text-base font-semibold">{title}</h2>
        {description && <p className="mt-0.5 text-sm text-muted-foreground">{description}</p>}
      </div>
      {children}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Hlavní stránka
// ---------------------------------------------------------------------------
export default function UsersPage() {
  const qc = useQueryClient();
  const [showCreate, setShowCreate] = useState(false);

  const { data: users = [], isLoading } = useQuery<UserFull[]>({
    queryKey: ["users"],
    queryFn:  () => usersApi.getAll(),
  });

  return (
    <div className="max-w-3xl space-y-6">

      {/* Seznam uživatelů */}
      <Section title="Uživatelé" description="Kliknutím na řádek otevřeš editaci.">
        <div className="flex justify-end">
          <Button variant="primary" size="sm" onClick={() => setShowCreate(v => !v)}>
            <UserPlus className="h-3.5 w-3.5" />
            {showCreate ? "Zavřít" : "Nový uživatel"}
          </Button>
        </div>

        {showCreate && (
          <div className="rounded-lg border border-primary/30 bg-primary/5 p-4">
            <p className="mb-3 text-sm font-medium">Vytvořit nového uživatele</p>
            <CreateUserForm onCreated={() => {
              setShowCreate(false);
              qc.invalidateQueries({ queryKey: ["users"] });
            }} />
          </div>
        )}

        {isLoading ? (
          <div className="flex h-24 items-center justify-center"><Spinner className="h-5 w-5" /></div>
        ) : (
          <div className="overflow-hidden rounded-lg border border-border">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-border bg-muted/50">
                  <th className="px-4 py-2.5 text-left text-xs font-medium text-muted-foreground">Uživatel</th>
                  <th className="px-4 py-2.5 text-left text-xs font-medium text-muted-foreground">Role</th>
                  <th className="px-4 py-2.5 text-left text-xs font-medium text-muted-foreground">Stav</th>
                  <th className="px-4 py-2.5 text-left text-xs font-medium text-muted-foreground">Vytvořen</th>
                  <th className="px-4 py-2.5 w-8" />
                </tr>
              </thead>
              <tbody>
                {users.length === 0 ? (
                  <tr><td colSpan={5} className="py-8 text-center text-sm text-muted-foreground">Žádní uživatelé</td></tr>
                ) : (
                  users.map((u) => <UserRow key={u.id} user={u} />)
                )}
              </tbody>
            </table>
          </div>
        )}
      </Section>

      {/* Generovat API klíč */}
      <Section title="Generovat API klíč"
        description="API klíče slouží pro skriptový přístup k backendu bez přihlášení.">
        <ApiKeyForm />
      </Section>

    </div>
  );
}
