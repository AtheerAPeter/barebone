import type { ComponentType, SVGProps } from 'react'
import {
  IconAlignLeft,
  IconArrowBackUp,
  IconArrowUp,
  IconArrowsExchange,
  IconBook,
  IconBrandTelegram,
  IconCheck,
  IconChevronDown,
  IconChevronLeft,
  IconChevronRight,
  IconClock,
  IconCopy,
  IconDeviceMobile,
  IconDotsVertical,
  IconDownload,
  IconFile,
  IconFileDiff,
  IconFolder,
  IconFolderPlus,
  IconGauge,
  IconGitBranch,
  IconKeyboard,
  IconLayoutSidebar,
  IconLock,
  IconMessage,
  IconMicrophone,
  IconMinus,
  IconMoon,
  IconPencil,
  IconPlayerPause,
  IconPlayerPlay,
  IconPlus,
  IconRefresh,
  IconRoute,
  IconSearch,
  IconServer,
  IconShield,
  IconSquareFilled,
  IconSun,
  IconTerminal2,
  IconTool,
  IconTrash,
  IconUserCog,
  IconVideo,
  IconVolume,
  IconWorld,
  IconX
} from '@tabler/icons-react'

type IconProps = SVGProps<SVGSVGElement>

/** The glyphs Tabler has no match for (the orb, the chat tree), on the same grid. */
function Icon({ children, ...props }: IconProps): React.JSX.Element {
  return (
    <svg
      width="16"
      height="16"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.8"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      {...props}
    >
      {children}
    </svg>
  )
}

/**
 * Tabler draws on the same 24-unit grid the interface was drawn on, so its
 * glyphs drop in at 16px. Pinning the 1.8 stroke here keeps them the same
 * weight as the few hand-drawn marks beside them; call sites can still pass
 * their own size (pick chevrons, the 28px settings tiles) and className.
 */
type TablerProps = SVGProps<SVGSVGElement> & { size?: number | string; stroke?: number | string }

function fromTabler(Source: ComponentType<TablerProps>): (p: IconProps) => React.JSX.Element {
  const Wrapped = (p: IconProps): React.JSX.Element => <Source size={16} stroke="1.8" {...p} />
  Wrapped.displayName = Source.displayName ?? 'TablerIcon'
  return Wrapped
}

export const PlusIcon = fromTabler(IconPlus)
export const FolderIcon = fromTabler(IconFolder)
export const ChevronIcon = fromTabler(IconChevronRight)
export const CloseIcon = fromTabler(IconX)
export const GlobeIcon = fromTabler(IconWorld)
export const BackIcon = fromTabler(IconChevronLeft)
export const ForwardIcon = fromTabler(IconChevronRight)
export const ReloadIcon = fromTabler(IconRefresh)
export const KeyboardIcon = fromTabler(IconKeyboard)
export const SendIcon = fromTabler(IconArrowUp)
export const StopIcon = fromTabler(IconSquareFilled)
export const MicIcon = fromTabler(IconMicrophone)
export const BookIcon = fromTabler(IconBook)
export const TrashIcon = fromTabler(IconTrash)
export const TerminalIcon = fromTabler(IconTerminal2)
export const PencilIcon = fromTabler(IconPencil)
export const WrenchIcon = fromTabler(IconTool)
export const DiffIcon = fromTabler(IconFileDiff)
export const GaugeIcon = fromTabler(IconGauge)
export const ShieldIcon = fromTabler(IconShield)
export const SidebarIcon = fromTabler(IconLayoutSidebar)
/** A window with a dot in its corner: the chat folded into the agent orb over the browser. */
export const OrbIcon = (p: IconProps): React.JSX.Element => (
  <Icon {...p}>
    <rect x="3" y="4" width="18" height="16" rx="2" />
    <circle cx="8" cy="15" r="2" fill="currentColor" stroke="none" />
  </Icon>
)
export const SunIcon = fromTabler(IconSun)
export const MoonIcon = fromTabler(IconMoon)
export const FileIcon = fromTabler(IconFile)
export const LockIcon = fromTabler(IconLock)
export const CopyIcon = fromTabler(IconCopy)
export const SearchIcon = fromTabler(IconSearch)
export const ChatIcon = fromTabler(IconMessage)
/** A pen over a page: start a new chat. Kept hand-drawn: Tabler's file-pencil reads as a document, not a new chat. */
export const ComposeIcon = (p: IconProps): React.JSX.Element => (
  <Icon {...p}>
    <path d="M12 4H6a2 2 0 0 0-2 2v12a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-6" />
    <path d="M18.4 3.6a2 2 0 0 1 2.9 2.9L12.5 15.3 9 16l.7-3.5z" />
  </Icon>
)
export const FolderPlusIcon = fromTabler(IconFolderPlus)
/** The chevron after a picker's value, as in ChatGPT's "Instant ⌄". */
export const ChevronDownIcon = fromTabler(IconChevronDown)
export const CheckIcon = fromTabler(IconCheck)
/** Vertical three dots: a row's options menu. */
export const MoreIcon = fromTabler(IconDotsVertical)
export const ClockIcon = fromTabler(IconClock)
/** A chat with the chats it started under it. */
export const LeadIcon = (p: IconProps): React.JSX.Element => (
  <Icon {...p}>
    <rect x="9" y="3" width="6" height="5" rx="1" />
    <path d="M12 8v3.5M5 11.5h14M5 11.5V15M12 11.5V15M19 11.5V15" />
    <rect x="3" y="15" width="4" height="5" rx="1" />
    <rect x="10" y="15" width="4" height="5" rx="1" />
    <rect x="17" y="15" width="4" height="5" rx="1" />
  </Icon>
)
/** Git's branch: source control and the branch picker. */
export const BranchIcon = fromTabler(IconGitBranch)
export const MinusIcon = fromTabler(IconMinus)
export const DiscardIcon = fromTabler(IconArrowBackUp)
export const SyncIcon = fromTabler(IconArrowsExchange)
export const PlayIcon = fromTabler(IconPlayerPlay)
export const PauseIcon = fromTabler(IconPlayerPause)
export const ServerIcon = fromTabler(IconServer)
export const TextIcon = fromTabler(IconAlignLeft)
export const VideoIcon = fromTabler(IconVideo)
export const RouteIcon = fromTabler(IconRoute)
export const SpeakerIcon = fromTabler(IconVolume)
export const DownloadIcon = fromTabler(IconDownload)
export const PhoneIcon = fromTabler(IconDeviceMobile)
/** Telegram's paper plane, on the Control from Telegram settings. */
export const TelegramIcon = fromTabler(IconBrandTelegram)
/** The persona the agent's main conversation runs as (Claude Code's custom agents). */
export const PersonaIcon = fromTabler(IconUserCog)
