import { Link } from "react-router-dom";
import { ChevronRight } from "lucide-react";
import { modules } from "@/lib/navigation";
import { canViewPage } from "@/lib/permissions";
import { useSession } from "@/lib/session";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
export function WorkspacePage({ id }: { id: string }) {
  const { session } = useSession();
  const module = modules.find((m) => m.id === id);
  if (!module) return null;
  return (
    <>
      <div className="space-y-1">
        <div className="flex items-center gap-2">
          <h1 className="text-2xl font-semibold tracking-tight">
            {module.title}
          </h1>
          <Badge variant="outline">Ish maydoni</Badge>
        </div>
        <p className="text-sm text-muted-foreground">{module.description}</p>
      </div>
      <div className="grid gap-6 md:grid-cols-2 xl:grid-cols-3">
        {module.groups.filter(group => group.pages.some(page => canViewPage(session, page.id))).map((group) => (
          <Card key={group.title}>
            <CardHeader>
              <CardTitle className="text-base">{group.title}</CardTitle>
              <CardDescription>{group.pages.filter(page => canViewPage(session, page.id)).length} ta sahifa</CardDescription>
            </CardHeader>
            <CardContent className="space-y-1">
              {group.pages.filter(page => canViewPage(session, page.id)).map((page) => (
                <Link
                  key={page.id}
                  to={`/app/${page.id}`}
                  className="group flex items-start gap-3 rounded-md p-3 transition-colors hover:bg-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                >
                  <page.icon className="mt-0.5 size-4 shrink-0 text-muted-foreground" />
                  <div className="min-w-0 flex-1">
                    <p className="text-sm font-medium">{page.title}</p>
                    <p className="mt-1 text-xs leading-relaxed text-muted-foreground">
                      {page.description}
                    </p>
                  </div>
                  <ChevronRight className="mt-0.5 size-4 text-muted-foreground" />
                </Link>
              ))}
            </CardContent>
          </Card>
        ))}
      </div>
    </>
  );
}
