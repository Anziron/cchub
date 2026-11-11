const PATHS: Record<string, string> = {
  plus: "M8 3v10M3 8h10",
  chev: "m6 3.5 4.5 4.5L6 12.5",
  down: "m4 6 4 4 4-4",
  up: "M8 13V3.5M3.8 7.5 8 3.3l4.2 4.2",
  gear: "M2.5 4.5h6M12 4.500h1.500M2.500 11.500h1.500M7.500 11.500h6M10.200 2.800a1.700 1.700 0 1 0 0 3.400 1.700 1.700 0 0 0 0-3.400ZM5.800 9.800a1.700 1.700 0 1 0 0 3.400 1.700 1.700 0 0 0 0-3.400Z",
  moon: "M13 9.700A5.500 5.500 0 0 1 6.300 3a5.500 5.500 0 1 0 6.700 6.700Z",
  palette: "M8 2.500a5.500 5.500 0 1 0 0 11c.9 0 1.300-.600 1.100-1.300-.300-.800.200-1.500 1-1.500H11.500a2 2 0 0 0 2-2c0-3.300-2.500-6.200-5.500-6.200ZM5 7.500v.01M7 5v.01M10 5.200v.01",
  term: "m3 4.500 3.500 3.500L3 11.500M8 12h5",
  file: "M4 2.500h5l3 3v8H4zM9 2.500v3h3",
  think: "M8 2v2M8 12v2M2 8h2M12 8h2M3.800 3.800l1.400 1.400M10.800 10.800l1.400 1.400M3.800 12.200l1.400-1.400M10.800 5.200l1.400-1.400",
  agents: "M5.500 3.200a2.300 2.300 0 1 0 0 4.600 2.300 2.300 0 0 0 0-4.600ZM1.800 13c.4-2.300 1.800-3.500 3.700-3.500s3.300 1.200 3.700 3.500M10.500 3.400a2.300 2.300 0 0 1 0 4.300M11.500 9.700c1.500.3 2.400 1.500 2.700 3.300",
  folder: "M2.500 4.500c0-.6.400-1 1-1h2.800l1.400 1.500h5.300c.6 0 1 .400 1 1v6c0 .6-.400 1-1 1h-9.500c-.6 0-1-.400-1-1zM2.500 6.500h11",
  check: "m3.500 8.500 3 3 6-7",
  reset: "M3 8a5 5 0 1 0 1.500-3.600M3 2.500V5h2.500",
  close: "m4 4 8 8M12 4l-8 8",
  edit: "M10.500 3 13 5.500 6 12.500H3.500V10zM9 4.500 11.500 7",
  back: "M10 3.500 5.500 8l4.500 4.500",
  tasks: "M3 4.500h10M3 8h10M3 11.500h6",
  chart: "M3 13.500V9M6.500 13.500V4.500M10 13.500V7.500M13.500 13.500V2.500",
  alert: "M8 2a6 6 0 1 0 0 12A6 6 0 0 0 8 2ZM8 5v3.500M8 11v.01",
  panel: "M2.500 3.500h11v9h-11zM9.500 3.500v9",
  enter: "M12.500 3.500v4.500a1 1 0 0 1-1 1h-8M6.500 6 3.500 9l3 3",
  copy: "M5.500 5.500h7v7h-7zM10.500 5.500v-2h-7v7h2",
  server: "M3 3h10v4H3zM3 9h10v4H3zM5.500 5v.01M5.500 11v.01",
  shield: "M8 2.300 3.200 4v3.600c0 3 2.100 5.200 4.800 6.100 2.700-.9 4.800-3.100 4.800-6.100V4z",
  diff: "M5 2.500v7M1.500 6h7M8.500 12.500h6",
  info: "M8 2a6 6 0 1 0 0 12A6 6 0 0 0 8 2ZM8 7.300v3.700M8 5v.01",
  plan: "M4 2.500h8v11H4zM6 5.500h4M6 8h4M6 10.500h2.500",
};

export function Icon({ name, size = 16, className }: { name: string; size?: number; className?: string }) {
  if (name === "more") {
    return <svg width={size} height={size} viewBox="0 0 16 16" className={className} aria-hidden="true"><circle cx="3.500" cy="8" r="1.200" fill="currentColor" /><circle cx="8" cy="8" r="1.200" fill="currentColor" /><circle cx="12.500" cy="8" r="1.200" fill="currentColor" /></svg>;
  }
  if (name === "stop") {
    return <svg width={size} height={size} viewBox="0 0 16 16" className={className}><rect x="4" y="4" width="8" height="8" rx="1.600" fill="currentColor" /></svg>;
  }
  return (
    <svg width={size} height={size} viewBox="0 0 16 16" className={className} aria-hidden="true">
      <path d={PATHS[name]} fill="none" stroke="currentColor" strokeWidth="1.250" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}
