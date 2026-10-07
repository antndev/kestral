// Inline-SVG icons from the design handoff. 16x16 box, 1.5 stroke, round caps,
// currentColor. Button icons render at 14px, close icons at 12px (pass size).

type Props = { size?: number; sw?: number };

function Icon({ size = 16, sw = 1.5, join = true, children }: Props & { join?: boolean; children: React.ReactNode }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      strokeWidth={sw}
      strokeLinecap="round"
      strokeLinejoin={join ? "round" : "miter"}
      aria-hidden="true"
    >
      {children}
    </svg>
  );
}

export const HostsIcon = (p: Props) => (
  <Icon {...p}>
    <rect x="2.5" y="2.5" width="11" height="4.5" rx="1" />
    <rect x="2.5" y="9" width="11" height="4.5" rx="1" />
    <path d="M5 4.75h.01M5 11.25h.01" />
  </Icon>
);
export const SftpIcon = (p: Props) => (
  <Icon {...p}>
    <path d="M2 4.5c0-.8.7-1.5 1.5-1.5H6l1.5 1.5h5c.8 0 1.5.7 1.5 1.5v6c0 .8-.7 1.5-1.5 1.5h-9c-.8 0-1.5-.7-1.5-1.5z" />
  </Icon>
);
export const KeyIcon = (p: Props) => (
  <Icon {...p}>
    <circle cx="5.5" cy="10.5" r="2.75" />
    <path d="M7.5 8.5 13.5 2.5M11 5l1.75 1.75M9.5 6.5l1.25 1.25" />
  </Icon>
);
export const SnippetIcon = (p: Props) => (
  <Icon {...p}>
    <path d="M5.5 4 1.5 8l4 4M10.5 4l4 4-4 4" />
  </Icon>
);
export const ForwardIcon = (p: Props) => (
  <Icon {...p}>
    <path d="M2 5.5h10M9.5 3 12 5.5 9.5 8M14 10.5H4M6.5 8 4 10.5 6.5 13" />
  </Icon>
);
export const ShieldIcon = (p: Props) => (
  <Icon {...p}>
    <path d="M8 1.75 3 3.75v4c0 3 2.2 5.1 5 6.25 2.8-1.15 5-3.25 5-6.25v-4z" />
  </Icon>
);
export const SearchIcon = ({ size = 16 }: Props) => (
  <Icon size={size} join={false}>
    <circle cx="7" cy="7" r="4.5" />
    <path d="m10.5 10.5 3 3" />
  </Icon>
);
export const SettingsIcon = ({ size = 16 }: Props) => (
  <Icon size={size}>
    <g transform="scale(0.6667)" strokeWidth={2.25}>
      <path d="M12.22 2h-.44a2 2 0 0 0-2 2v.18a2 2 0 0 1-1 1.73l-.43.25a2 2 0 0 1-2 0l-.15-.08a2 2 0 0 0-2.73.73l-.22.38a2 2 0 0 0 .73 2.73l.15.1a2 2 0 0 1 1 1.72v.51a2 2 0 0 1-1 1.74l-.15.09a2 2 0 0 0-.73 2.73l.22.38a2 2 0 0 0 2.73.73l.15-.08a2 2 0 0 1 2 0l.43.25a2 2 0 0 1 1 1.73V20a2 2 0 0 0 2 2h.44a2 2 0 0 0 2-2v-.18a2 2 0 0 1 1-1.73l.43-.25a2 2 0 0 1 2 0l.15.08a2 2 0 0 0 2.73-.73l.22-.39a2 2 0 0 0-.73-2.73l-.15-.08a2 2 0 0 1-1-1.74v-.5a2 2 0 0 1 1-1.74l.15-.09a2 2 0 0 0 .73-2.73l-.22-.38a2 2 0 0 0-2.73-.73l-.15.08a2 2 0 0 1-2 0l-.43-.25a2 2 0 0 1-1-1.73V4a2 2 0 0 0-2-2z" />
      <circle cx="12" cy="12" r="3" />
    </g>
  </Icon>
);
export const LockIcon = ({ size = 16 }: Props) => (
  <Icon size={size} join={false}>
    <rect x="3" y="7" width="10" height="7" rx="1.5" />
    <path d="M5.5 7V5a2.5 2.5 0 0 1 5 0v2" />
  </Icon>
);
export const PlusIcon = ({ size = 16, sw = 1.5 }: Props) => (
  <Icon size={size} sw={sw} join={false}>
    <path d="M8 3v10M3 8h10" />
  </Icon>
);
export const ChevronIcon = ({ size = 14 }: Props) => (
  <Icon size={size}>
    <path d="m4.5 6.5 3.5 3.5 3.5-3.5" />
  </Icon>
);
export const DotsIcon = ({ size = 14 }: Props) => (
  <Icon size={size} sw={2.5} join={false}>
    <path d="M3.5 8h.01M8 8h.01M12.5 8h.01" />
  </Icon>
);
export const CloseIcon = ({ size = 12 }: Props) => (
  <Icon size={size} join={false}>
    <path d="m4 4 8 8M12 4l-8 8" />
  </Icon>
);
export const SidebarToggleIcon = ({ size = 16 }: Props) => (
  <Icon size={size} join={false}>
    <rect x="2" y="3" width="12" height="10" rx="1.5" />
    <path d="M6 3v10" />
  </Icon>
);
// Terminal "Split" toolbar icon: split cell, divider centered.
export const SplitIcon = ({ size = 14 }: Props) => (
  <Icon size={size} join={false}>
    <rect x="2" y="3" width="12" height="10" rx="1.5" />
    <path d="M8 3v10" />
  </Icon>
);
export const UploadIcon = ({ size = 14 }: Props) => (
  <Icon size={size}>
    <path d="M8 13V3.5M4.5 7 8 3.5 11.5 7" />
  </Icon>
);
export const DownloadIcon = ({ size = 14 }: Props) => (
  <Icon size={size}>
    <path d="M8 3v9.5M4.5 9 8 12.5 11.5 9" />
  </Icon>
);
export const FolderIcon = ({ size = 14 }: Props) => (
  <Icon size={size}>
    <path d="M2 4.5c0-.8.7-1.5 1.5-1.5H6l1.5 1.5h5c.8 0 1.5.7 1.5 1.5v6c0 .8-.7 1.5-1.5 1.5h-9c-.8 0-1.5-.7-1.5-1.5z" />
  </Icon>
);
export const FolderPlusIcon = ({ size = 14 }: Props) => (
  <Icon size={size}>
    <path d="M2 4.5c0-.8.7-1.5 1.5-1.5H6l1.5 1.5h5c.8 0 1.5.7 1.5 1.5v6c0 .8-.7 1.5-1.5 1.5h-9c-.8 0-1.5-.7-1.5-1.5z" />
    <path d="M8 7v4M6 9h4" />
  </Icon>
);
export const RefreshIcon = ({ size = 14 }: Props) => (
  <Icon size={size}>
    <path d="M13.25 8A5.25 5.25 0 1 1 11.7 4.3M13.25 2.5v3h-3" />
  </Icon>
);
export const FileIcon = ({ size = 14 }: Props) => (
  <Icon size={size}>
    <path d="M4 1.75h5l3 3v9.5H4z" />
    <path d="M9 1.75v3h3" />
  </Icon>
);
export const CopyIcon = ({ size = 14 }: Props) => (
  <Icon size={size}>
    <rect x="5.5" y="5.5" width="8" height="8" rx="1.25" />
    <path d="M3 10.5V3.75C3 3.3 3.3 3 3.75 3h6.75" />
  </Icon>
);
export const TrashIcon = ({ size = 14 }: Props) => (
  <Icon size={size}>
    <path d="M2.5 4.5h11M6 4.5V3h4v1.5M4 4.5l.7 9h6.6l.7-9" />
  </Icon>
);
export const PlayIcon = ({ size = 12 }: Props) => (
  <svg width={size} height={size} viewBox="0 0 16 16" fill="currentColor" aria-hidden="true">
    <path d="M5 3.5v9l7.5-4.5z" />
  </svg>
);
export const WarningIcon = ({ size = 16 }: Props) => (
  <Icon size={size}>
    <path d="M8 2 14.5 13.5h-13z" />
    <path d="M8 6.5v3M8 11.5h.01" />
  </Icon>
);
export const CheckIcon = ({ size = 12 }: Props) => (
  <Icon size={size} sw={2}>
    <path d="m3.5 8.5 3 3 6-7" />
  </Icon>
);
export const CpuIcon = (p: Props) => (
  <Icon {...p}>
    <rect x="4.5" y="4.5" width="7" height="7" rx="1" />
    <path d="M6.5 1.5v2M9.5 1.5v2M6.5 12.5v2M9.5 12.5v2M1.5 6.5h2M1.5 9.5h2M12.5 6.5h2M12.5 9.5h2" />
  </Icon>
);
export const LogsIcon = (p: Props) => (
  <Icon {...p}>
    <path d="M4 2.5h6l2.5 2.5v8.5H4z" />
    <path d="M6 7h4M6 9.5h4M6 12h2.5" />
  </Icon>
);
export const TerminalTabIcon = ({ size = 14 }: Props) => (
  <Icon size={size}>
    <rect x="2" y="3" width="12" height="10" rx="1.5" />
    <path d="m4.5 6.5 2 1.5-2 1.5M8 9.5h3" />
  </Icon>
);
export const CollapseIcon = ({ size = 12 }: Props) => (
  <Icon size={size}>
    <path d="M13 7H9V3M3 9h4v4M9 7l4.5-4.5M7 9l-4.5 4.5" />
  </Icon>
);
