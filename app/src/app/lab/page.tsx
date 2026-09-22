import type { Metadata } from "next";
import Lab from "@/components/Lab";

export const metadata: Metadata = { title: "Lab · Bellcurve" };

export default function LabPage() {
  return (
    <main className="mx-auto max-w-7xl px-5 pt-10">
      <Lab />
    </main>
  );
}
