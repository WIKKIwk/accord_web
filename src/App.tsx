import {
  BrowserRouter,
  Navigate,
  Route,
  Routes,
  useParams,
} from "react-router-dom";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { Toaster } from "@/components/ui/sonner";
import { SessionProvider, useSession } from "@/lib/session";
import { pageById, modules } from "@/lib/navigation";
import { AppShell } from "@/components/app-shell";
import { LoginPage } from "@/pages/LoginPage";
import { WorkspacePage } from "@/pages/WorkspacePage";
import { DashboardPage } from "@/pages/DashboardPage";
import { ResourcePage } from "@/pages/ResourcePage";
import { SettingsPage, ServerPage } from "@/pages/SystemPages";
import { CalculatorPage } from "@/pages/CalculatorPage";
import { ProductionMapPage } from "@/pages/ProductionMapPage";
import { ProductionWorkflowProvider } from "@/lib/production-workflow";
import { Loader2 } from "lucide-react";
const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      staleTime: 30_000,
      gcTime: 10 * 60_000,
      retry: 1,
      refetchOnWindowFocus: false,
    },
  },
});
function Guard() {
  const { session, restoring } = useSession();
  if (restoring)
    return (
      <div className="flex min-h-svh items-center justify-center gap-2 text-sm text-muted-foreground">
        <Loader2 className="size-4 animate-spin" />
        Sessiya tiklanmoqda…
      </div>
    );
  return session ? <AppShell /> : <Navigate to="/kirish" replace />;
}
function Page() {
  const { pageId = "home" } = useParams();
  if (pageId === "home") return <DashboardPage />;
  if (modules.some((m) => m.id === pageId))
    return <WorkspacePage id={pageId} />;
  if (pageId === "settings") return <SettingsPage />;
  if (pageId === "server") return <ServerPage />;
  if (pageId === "calculate") return <CalculatorPage />;
  if (pageId === "map-editor") return <ProductionMapPage />;
  const page = pageById(pageId);
  if (page?.resource) return <ResourcePage key={pageId} page={page} />;
  return (
    <div className="space-y-2">
      <h1 className="text-2xl font-semibold">Sahifa topilmadi</h1>
      <p className="text-sm text-muted-foreground">
        Chap menyudan kerakli ish maydonini tanlang.
      </p>
    </div>
  );
}
export default function App() {
  return (
    <QueryClientProvider client={queryClient}>
      <SessionProvider>
        <BrowserRouter>
          <ProductionWorkflowProvider>
            <Routes>
              <Route path="/kirish" element={<LoginPage />} />
              <Route path="/app" element={<Guard />}>
                <Route index element={<Navigate to="/app/home" replace />} />
                <Route path=":pageId" element={<Page />} />
              </Route>
              <Route path="*" element={<Navigate to="/app/home" replace />} />
            </Routes>
          </ProductionWorkflowProvider>
        </BrowserRouter>
        <Toaster richColors position="top-right" />
      </SessionProvider>
    </QueryClientProvider>
  );
}
