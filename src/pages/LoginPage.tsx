import { useState } from "react";
import type { FormEvent } from "react";
import { useNavigate } from "react-router-dom";
import {
  ArrowRight,
  Eye,
  Factory,
  Loader2,
  Server,
  ShieldCheck,
} from "lucide-react";
import { useSession } from "@/lib/session";
import { ThemeButton } from "@/components/app-shell";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardFooter,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Separator } from "@/components/ui/separator";
export function LoginPage() {
  const { endpoint, login, enterDemo } = useSession();
  const navigate = useNavigate();
  const [domain, setDomain] = useState(endpoint),
    [phone, setPhone] = useState(""),
    [code, setCode] = useState("");
  const [busy, setBusy] = useState(false),
    [error, setError] = useState("");
  async function submit(event: FormEvent) {
    event.preventDefault();
    setBusy(true);
    setError("");
    try {
      await login(domain, phone, code);
      setCode("");
      navigate("/app/home", { replace: true });
    } catch (e) {
      setError(e instanceof Error ? e.message : "Kirish amalga oshmadi.");
    } finally {
      setBusy(false);
    }
  }
  return (
    <div className="flex min-h-svh flex-col bg-muted/30">
      <header className="flex items-center justify-between px-6 py-4">
        <div className="flex items-center gap-2 text-sm font-semibold">
          <Factory className="size-5" />
          Accord MES
        </div>
        <ThemeButton />
      </header>
      <main className="flex flex-1 items-center justify-center px-4 py-10">
        <div className="w-full max-w-md space-y-6">
          <div className="text-center">
            <div className="mx-auto mb-4 flex size-12 items-center justify-center rounded-xl bg-primary text-primary-foreground">
              <Factory className="size-6" />
            </div>
            <h1 className="text-2xl font-semibold tracking-tight">
              Ish maydoningizga kiring
            </h1>
            <p className="mt-2 text-sm text-muted-foreground">
              Ishlab chiqarish va omborni yagona joydan boshqaring.
            </p>
          </div>
          <Card>
            <CardHeader>
              <CardTitle>Accord MES</CardTitle>
              <CardDescription>
                ERP serveringiz va administrator hisobingiz bilan ulaning.
              </CardDescription>
            </CardHeader>
            <form onSubmit={submit}>
              <CardContent className="space-y-4">
                {error && (
                  <Alert variant="destructive">
                    <AlertDescription>{error}</AlertDescription>
                  </Alert>
                )}
                <div className="space-y-2">
                  <Label htmlFor="domain">Server manzili</Label>
                  <div className="relative">
                    <Server className="absolute left-3 top-2.5 size-4 text-muted-foreground" />
                    <Input
                      id="domain"
                      className="pl-9"
                      placeholder="erp.korxona.uz"
                      value={domain}
                      onChange={(e) => setDomain(e.target.value)}
                      autoCapitalize="none"
                      autoCorrect="off"
                      required
                      disabled={busy}
                    />
                  </div>
                  <p className="text-xs text-muted-foreground">
                    Korxonangizning ERP domenini kiriting.
                  </p>
                </div>
                <div className="space-y-2">
                  <Label htmlFor="phone">Telefon raqami</Label>
                  <Input
                    id="phone"
                    type="tel"
                    placeholder="+998901234567"
                    value={phone}
                    onChange={(e) => setPhone(e.target.value)}
                    autoComplete="username"
                    required
                    disabled={busy}
                  />
                </div>
                <div className="space-y-2">
                  <Label htmlFor="code">Kirish kodi</Label>
                  <Input
                    id="code"
                    type="password"
                    placeholder="Kirish kodingiz"
                    value={code}
                    onChange={(e) => setCode(e.target.value)}
                    autoComplete="current-password"
                    required
                    disabled={busy}
                  />
                </div>
                <Button className="w-full" type="submit" disabled={busy}>
                  {busy ? <Loader2 className="animate-spin" /> : <ArrowRight />}
                  Kirish
                </Button>
              </CardContent>
            </form>
            <CardFooter className="flex-col gap-4">
              <Separator />
              <Button
                variant="outline"
                className="w-full"
                disabled={busy}
                onClick={() => {
                  enterDemo();
                  navigate("/app/home");
                }}
              >
                <Eye />
                Admin interfeysini ko‘rish
              </Button>
            </CardFooter>
          </Card>
          <div className="flex items-center justify-center gap-2 text-xs text-muted-foreground">
            <ShieldCheck className="size-3.5" />
            Administrator uchun ish maydoni
          </div>
        </div>
      </main>
      <footer className="py-4 text-center text-xs text-muted-foreground">
        Accord · MES va ombor boshqaruvi
      </footer>
    </div>
  );
}
