import { useEffect, useState } from "react";
import { Link, Outlet, useLocation, useNavigate } from "react-router-dom";
import { useQueryClient } from "@tanstack/react-query";
import {
  ChevronRight,
  ChevronsUpDown,
  Factory,
  House,
  LogOut,
  Moon,
  Search,
  Settings,
  Sun,
  Wifi,
  WifiOff,
  RefreshCw,
  ShieldCheck,
} from "lucide-react";
import { useSession } from "@/lib/session";
import { modules, allPages, pageById, moduleForPage } from "@/lib/navigation";
import { canViewPage } from "@/lib/permissions";
import {
  Sidebar,
  SidebarContent,
  SidebarFooter,
  SidebarGroup,
  SidebarGroupLabel,
  SidebarHeader,
  SidebarInset,
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
  SidebarMenuSub,
  SidebarMenuSubButton,
  SidebarMenuSubItem,
  SidebarProvider,
  SidebarTrigger,
  useSidebar,
} from "@/components/ui/sidebar";
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "@/components/ui/collapsible";
import {
  Breadcrumb,
  BreadcrumbItem,
  BreadcrumbLink,
  BreadcrumbList,
  BreadcrumbPage,
  BreadcrumbSeparator,
} from "@/components/ui/breadcrumb";
import {
  Command,
  CommandDialog,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
  CommandSeparator,
} from "@/components/ui/command";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Avatar, AvatarFallback } from "@/components/ui/avatar";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Separator } from "@/components/ui/separator";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";

export function ThemeButton() {
  const [dark, setDark] = useState(() => {
    try {
      return localStorage.getItem("accord.web.v2.theme") === "dark";
    } catch {
      return false;
    }
  });
  useEffect(() => {
    document.documentElement.classList.toggle("dark", dark);
    try {
      localStorage.setItem("accord.web.v2.theme", dark ? "dark" : "light");
    } catch {
      /* Optional preference. */
    }
  }, [dark]);
  return (
    <Button
      variant="ghost"
      size="icon"
      aria-label={dark ? "Yorug‘ mavzu" : "Qorong‘i mavzu"}
      onClick={() => setDark(!dark)}
    >
      {dark ? <Sun /> : <Moon />}
    </Button>
  );
}

export function AppShell() {
  return (
    <SidebarProvider>
      <AppShellContent />
    </SidebarProvider>
  );
}

function AppShellContent() {
  const { state, isMobile } = useSidebar();
  const { session, demo, endpoint, connection, logout, reconnect } =
    useSession();
  const navigate = useNavigate();
  const location = useLocation();
  const queryClient = useQueryClient();
  const pageId = location.pathname.split("/")[2] || "home";
  const page = pageById(pageId);
  const currentModule = moduleForPage(pageId);
  const [searchOpen, setSearchOpen] = useState(false);
  const [openModule, setOpenModule] = useState(currentModule?.id || "");
  useEffect(() => {
    if (currentModule) setOpenModule(currentModule.id);
  }, [currentModule]);
  useEffect(() => {
    document.title = `${page?.title || "Accord"} · Accord MES`;
  }, [page?.title]);
  useEffect(() => {
    const handle = (event: KeyboardEvent) => {
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "k") {
        event.preventDefault();
        setSearchOpen((v) => !v);
      }
    };
    window.addEventListener("keydown", handle);
    return () => window.removeEventListener("keydown", handle);
  }, []);
  const host = demo
    ? "Admin interfeysi"
    : endpoint
      ? new URL(endpoint).host
      : "Server";
  const displayName = session?.profile.display_name || "Administrator";
  return (
    <>
      <CloseMobileDrawer />
      <Sidebar collapsible="icon">
        <SidebarHeader>
          <SidebarMenu>
            <SidebarMenuItem>
              <SidebarMenuButton size="lg" asChild>
                <Link to="/app/home">
                  <div className="flex aspect-square size-8 items-center justify-center rounded-lg bg-primary text-primary-foreground">
                    <Factory className="size-4" />
                  </div>
                  <div className="grid flex-1 text-left text-sm leading-tight">
                    <span className="truncate font-semibold">Accord MES</span>
                    <span className="truncate text-xs text-muted-foreground">
                      Ishlab chiqarish va ombor
                    </span>
                  </div>
                </Link>
              </SidebarMenuButton>
            </SidebarMenuItem>
          </SidebarMenu>
        </SidebarHeader>
        <SidebarContent>
          <SidebarGroup>
            <SidebarGroupLabel>Ish maydonlari</SidebarGroupLabel>
            <SidebarMenu>
              <SidebarMenuItem>
                <SidebarMenuButton
                  asChild
                  isActive={pageId === "home"}
                  tooltip="Bosh sahifa"
                >
                  <Link to="/app/home">
                    <House />
                    <span>Bosh sahifa</span>
                  </Link>
                </SidebarMenuButton>
              </SidebarMenuItem>
              {modules.filter(module => canViewPage(session, module.id)).map((module) => (
                <Collapsible
                  key={module.id}
                  asChild
                  open={openModule === module.id}
                  onOpenChange={(open) => setOpenModule(open ? module.id : "")}
                  className="group/collapsible"
                >
                  <SidebarMenuItem>
                    <CollapsibleTrigger asChild>
                      <SidebarMenuButton
                        tooltip={module.title}
                        isActive={currentModule?.id === module.id}
                        onClick={() => {
                          if (state === "collapsed" && !isMobile)
                            navigate(`/app/${module.id}`);
                        }}
                      >
                        <module.icon />
                        <span>{module.title}</span>
                        <ChevronRight className="ml-auto transition-transform group-data-[state=open]/collapsible:rotate-90" />
                      </SidebarMenuButton>
                    </CollapsibleTrigger>
                    <CollapsibleContent>
                      <SidebarMenuSub>
                        <SidebarMenuSubItem>
                          <SidebarMenuSubButton
                            asChild
                            isActive={pageId === module.id}
                          >
                            <Link to={`/app/${module.id}`}>
                              Umumiy ko‘rinish
                            </Link>
                          </SidebarMenuSubButton>
                        </SidebarMenuSubItem>
                        {module.groups.filter(group => group.pages.some(child => canViewPage(session, child.id))).map((group) => (
                          <div key={group.title} className="pt-2">
                            <div className="px-2 pb-1 text-[11px] font-medium text-muted-foreground">
                              {group.title}
                            </div>
                            {group.pages.filter(child => canViewPage(session, child.id)).map((child) => (
                              <SidebarMenuSubItem key={child.id}>
                                <SidebarMenuSubButton
                                  asChild
                                  isActive={pageId === child.id}
                                >
                                  <Link to={`/app/${child.id}`}>
                                    <span>{child.title}</span>
                                  </Link>
                                </SidebarMenuSubButton>
                              </SidebarMenuSubItem>
                            ))}
                          </div>
                        ))}
                      </SidebarMenuSub>
                    </CollapsibleContent>
                  </SidebarMenuItem>
                </Collapsible>
              ))}
            </SidebarMenu>
          </SidebarGroup>
          <SidebarGroup className="mt-auto">
            <SidebarMenu>
              <SidebarMenuItem>
                <SidebarMenuButton
                  onClick={() => setSearchOpen(true)}
                  tooltip="Sahifani qidirish"
                >
                  <Search />
                  <span>Sahifani qidirish</span>
                  <kbd className="ml-auto text-xs text-muted-foreground">
                    ⌘ K
                  </kbd>
                </SidebarMenuButton>
              </SidebarMenuItem>
            </SidebarMenu>
          </SidebarGroup>
        </SidebarContent>
        <SidebarFooter>
          <SidebarMenu>
            <SidebarMenuItem>
              <DropdownMenu>
                <DropdownMenuTrigger asChild>
                  <SidebarMenuButton size="lg">
                    <Avatar className="size-8 rounded-lg">
                      <AvatarFallback className="rounded-lg">
                        {displayName.slice(0, 2).toLocaleUpperCase("uz")}
                      </AvatarFallback>
                    </Avatar>
                    <div className="grid flex-1 text-left text-sm leading-tight">
                      <span className="truncate font-medium">
                        {displayName}
                      </span>
                      <span className="truncate text-xs text-muted-foreground">
                        Administrator
                      </span>
                    </div>
                    <ChevronsUpDown className="ml-auto size-4" />
                  </SidebarMenuButton>
                </DropdownMenuTrigger>
                <DropdownMenuContent side="top" align="end" className="w-60">
                  <DropdownMenuLabel>
                    <div className="flex items-center gap-2">
                      <ShieldCheck className="size-4" />
                      Administrator
                    </div>
                    <p className="mt-1 truncate text-xs font-normal text-muted-foreground">
                      {host}
                    </p>
                  </DropdownMenuLabel>
                  <DropdownMenuSeparator />
                  {canViewPage(session, 'settings') && <DropdownMenuItem onSelect={() => navigate("/app/settings")}>
                    <Settings />
                    Sozlamalar
                  </DropdownMenuItem>}
                  <DropdownMenuSeparator />
                  <DropdownMenuItem
                    onSelect={() => {
                      void logout().then(() => navigate("/kirish"));
                    }}
                  >
                    <LogOut />
                    {demo ? "Ko‘rish rejimidan chiqish" : "Hisobdan chiqish"}
                  </DropdownMenuItem>
                </DropdownMenuContent>
              </DropdownMenu>
            </SidebarMenuItem>
          </SidebarMenu>
        </SidebarFooter>
      </Sidebar>
      <SidebarInset>
        <header className="flex h-14 shrink-0 items-center gap-3 border-b px-4 lg:px-6">
          <SidebarTrigger aria-label="Menyuni ochish yoki yopish" />
          <Separator orientation="vertical" className="h-4" />
          <Breadcrumb>
            <BreadcrumbList>
              <BreadcrumbItem className="hidden sm:block">
                <BreadcrumbLink asChild>
                  <Link to="/app/home">Accord</Link>
                </BreadcrumbLink>
              </BreadcrumbItem>
              <BreadcrumbSeparator className="hidden sm:block" />
              {currentModule && pageId !== currentModule.id && (
                <>
                  <BreadcrumbItem className="hidden md:block">
                    <BreadcrumbLink asChild>
                      <Link to={`/app/${currentModule.id}`}>
                        {currentModule.title}
                      </Link>
                    </BreadcrumbLink>
                  </BreadcrumbItem>
                  <BreadcrumbSeparator className="hidden md:block" />
                </>
              )}
              <BreadcrumbItem>
                <BreadcrumbPage>{page?.title || "Sahifa"}</BreadcrumbPage>
              </BreadcrumbItem>
            </BreadcrumbList>
          </Breadcrumb>
          <div className="ml-auto flex items-center gap-1 sm:gap-2">
            <Button
              variant="outline"
              className="hidden h-8 w-52 justify-start gap-2 text-muted-foreground lg:flex"
              onClick={() => setSearchOpen(true)}
            >
              <Search className="size-4" />
              Qidirish
              <kbd className="ml-auto rounded border px-1 text-[10px]">⌘ K</kbd>
            </Button>
            <span className="hidden items-center gap-1.5 text-xs text-muted-foreground sm:flex">
              {connection === "offline" ? (
                <WifiOff className="size-3.5" />
              ) : (
                <Wifi className="size-3.5" />
              )}
              {demo
                ? "Ko‘rish rejimi"
                : connection === "offline"
                  ? "Ulanish yo‘q"
                  : host}
            </span>
            <Button
              variant="ghost"
              size="icon"
              aria-label="Ma’lumotlarni yangilash"
              onClick={() => {
                void queryClient.invalidateQueries();
              }}
            >
              <RefreshCw />
            </Button>
            <ThemeButton />
          </div>
        </header>
        {demo && (
          <div className="flex flex-wrap items-center justify-between gap-2 border-b bg-muted/40 px-6 py-2 text-xs text-muted-foreground">
            <span>
              <Badge variant="outline" className="mr-2">
                Ko‘rish rejimi
              </Badge>
              Namunaviy ma’lumotlar. Real serverga so‘rov yuborilmaydi.
            </span>
            <Button
              variant="link"
              size="sm"
              className="h-auto p-0 text-xs"
              onClick={() => {
                void logout().then(() => navigate("/kirish"));
              }}
            >
              Serverga ulanish
              <ChevronRight className="size-3" />
            </Button>
          </div>
        )}
        {connection === "offline" && !demo && (
          <div className="px-6 pt-4">
            <Alert>
              <WifiOff />
              <AlertTitle>Server bilan aloqa uzildi</AlertTitle>
              <AlertDescription>
                Sessiya saqlangan. Ulanish tiklangach ma’lumotlarni
                yangilashingiz mumkin.
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() => {
                    void reconnect();
                  }}
                >
                  Qayta ulanish
                </Button>
              </AlertDescription>
            </Alert>
          </div>
        )}
        <main className="mx-auto w-full max-w-[1600px] flex-1 space-y-6 p-4 md:p-6 lg:p-8">
          <Outlet />
        </main>
        <footer className="flex flex-wrap justify-between gap-2 border-t px-6 py-3 text-xs text-muted-foreground">
          <span>Accord MES</span>
          <span>Ishlab chiqarish · Ombor boshqaruvi</span>
        </footer>
      </SidebarInset>
      <CommandDialog
        title="Sahifani qidirish"
        description="Kerakli ish maydoni yoki sahifaga tezkor o‘tish."
        open={searchOpen}
        onOpenChange={setSearchOpen}
      >
        <Command>
          <CommandInput placeholder="Buyurtma, ombor yoki sahifani qidiring…" />
          <CommandList>
            <CommandEmpty>Sahifa topilmadi.</CommandEmpty>
            <CommandGroup heading="Ish maydoni">
              <CommandItem
                onSelect={() => {
                  navigate("/app/home");
                  setSearchOpen(false);
                }}
              >
                <House />
                Bosh sahifa
              </CommandItem>
            </CommandGroup>
            {modules.filter(module => canViewPage(session, module.id)).map((module) => (
              <div key={module.id}>
                <CommandSeparator />
                <CommandGroup heading={module.title}>
                  {allPages
                    .filter((p) => moduleForPage(p.id)?.id === module.id && canViewPage(session, p.id))
                    .map((p) => (
                      <CommandItem
                        key={p.id}
                        value={`${module.title} ${p.title}`}
                        onSelect={() => {
                          navigate(`/app/${p.id}`);
                          setSearchOpen(false);
                        }}
                      >
                        <p.icon />
                        {p.title}
                      </CommandItem>
                    ))}
                </CommandGroup>
              </div>
            ))}
          </CommandList>
        </Command>
      </CommandDialog>
    </>
  );
}

function CloseMobileDrawer() {
  const { setOpenMobile } = useSidebar();
  const { pathname } = useLocation();
  useEffect(() => {
    setOpenMobile(false);
    window.scrollTo({ top: 0, left: 0, behavior: "instant" });
  }, [pathname, setOpenMobile]);
  return null;
}
