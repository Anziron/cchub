const PATHS: Record<string, string> = {
  plus: "M8 3v10M3 8h10",
  chev: "m6 3.5 4.5 4.5L6 12.5",
  down: "m4 6 4 4 4-4",
  up: "M8 13V3.5M3.8 7.5 8 3.3l4.2 4.2",
  gear: "M2.5 4.5h6M12 4.500h1.500M2.500 11.500h1.500M7.500 11.500h6M10.200 2.800a1.700 1.700 0 1 0 0 3.400 1.700 1.700 0 0 0 0-3.400ZM5.800 9.800a1.700 1.700 0 1 0 0 3.400 1.700 1.700 0 0 0 0-3.400Z",
  moon: "M13 9.700A5.500 5.500 0 0 1 6.300 3a5.500 5.500 0 1 0 6.700 6.700Z",
  term: "m3 4.500 3.500 3.500L3 11.500M8 12h5",
  file: "M4 2.500h5l3 3v8H4zM9 2.500v3h3",
  think: "M8 2v2M8 12v2M2 8h2M12 8h2M3.800 3.800l1.400 1.400M10.800 10.800l1.400 1.400M3.800 12.200l1.400-1.400M10.800 5.200l1.400-1.400",
  agents: "M5.500 3.200a2.300 2.300 0 1 0 0 4.600 2.300 2.300 0 0 0 0-4.600ZM1.800 13c.4-2.300 1.800-3.500 3.700-3.500s3.300 1.200 3.700 3.500M10.500 3.400a2.300 2.300 0 0 1 0 4.300M11.500 9.700c1.500.3 2.400 1.500 2.700 3.300",
  folder: "M2.500 4.500c0-.6.400-1 1-1h2.800l1.400 1.500h5.300c.6 0 1 .400 1 1v6c0 .6-.400 1-1 1h-9.500c-.6 0-1-.400-1-1zM2.500 6.500h11",
  check: "m3.500 8.500 3 3 6-7",
  close: "m4 4 8 8M12 4l-8 8",
  back: "M10 3.500 5.500 8l4.500 4.500",
  tasks: "M3 4.500h10M3 8h10M3 11.500h6",
  alert: "M8 2a6 6 0 1 0 0 12A6 6 0 0 0 8 2ZM8 5v3.500M8 11v.01",
};

export function Icon({ name, size = 16, className }: { name: string; size?: number; className?: string }) {
  if (name === "stop") {
    return <svg width={size} height={size} viewBox="0 0 16 16" className={className}><rect x="4" y="4" width="8" height="8" rx="1.600" fill="currentColor" /></svg>;
  }
  return (
    <svg width={size} height={size} viewBox="0 0 16 16" className={className} aria-hidden="true">
      <path d={PATHS[name]} fill="none" stroke="currentColor" strokeWidth="1.250" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}
