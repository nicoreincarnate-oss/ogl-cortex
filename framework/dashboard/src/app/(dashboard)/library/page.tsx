import { ProofHeader } from '@/components/proof/proof-header';

export default function LibraryPage() {
  return (
    <div className="flex h-full flex-col gap-4 p-4 md:p-8">
      <ProofHeader kicker="Proof · where the methods come from" title="Kem library">
        Every method Kem (Glitch Cat Club) teaches, quoted from his videos and posts, searchable. The Proof pages are built from these.
      </ProofHeader>
      <iframe src="/proof/kem-library.html" title="Kem library" className="min-h-[75vh] w-full flex-1 border-2 border-foreground bg-card shadow-[var(--ogl-shadow)]" />
    </div>
  );
}
