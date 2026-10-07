export function Stable({ text, alts, align = "center" }: { text: string; alts: string[]; align?: "start" | "center" | "end" }) {
  const all = alts.includes(text) ? alts : [...alts, text];
  return (
    <span style={{ display: "inline-grid", justifyItems: align }}>
      {all.map((t) => (
        <span key={t} aria-hidden={t === text ? undefined : true} style={{ gridArea: "1 / 1", visibility: t === text ? "visible" : "hidden", whiteSpace: "nowrap" }}>
          {t}
        </span>
      ))}
    </span>
  );
}
