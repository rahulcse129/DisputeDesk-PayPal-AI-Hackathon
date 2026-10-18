import { Suspense } from "react";
import { DisputeView } from "./dispute-view";
import { Skeleton } from "@/app/components/ui";

export default function DisputePage({ params }: PageProps<"/disputes/[id]">) {
  return (
    <Suspense fallback={<Skeleton className="h-96" />}>
      <DisputeLoader params={params} />
    </Suspense>
  );
}

async function DisputeLoader({ params }: { params: PageProps<"/disputes/[id]">["params"] }) {
  const { id } = await params;
  return <DisputeView id={id} />;
}
