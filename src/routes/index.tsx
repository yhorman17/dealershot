import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { useEffect } from "react";
import { useAuth } from "@/hooks/use-auth";
import { PageSkeleton } from "@/components/product-ui";

export const Route = createFileRoute("/")({
  head: () => ({
    meta: [
      { title: "DealerShot" },
      {
        name: "description",
        content: "Vehicle inventory and photo management for car dealerships.",
      },
    ],
  }),
  component: Index,
});

function Index() {
  const { session, loading } = useAuth();
  const navigate = useNavigate();

  useEffect(() => {
    if (loading) return;
    navigate({ to: session ? "/dashboard" : "/login", replace: true });
  }, [session, loading, navigate]);

  return <PageSkeleton cards={3} rows={4} />;
}
