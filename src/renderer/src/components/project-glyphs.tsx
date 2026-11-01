import { useId, type ReactNode, type SVGProps } from 'react'

type GlyphProps = SVGProps<SVGSVGElement>

/**
 * A solid glyph: `children` filled in the current color, with `cut` (strokes)
 * cut out of it through a mask, so the cut shows whatever is behind the icon.
 */
function Solid({ children, cut, ...props }: GlyphProps & { cut?: ReactNode }): React.JSX.Element {
  const mask = useId()
  return (
    <svg
      width="16"
      height="16"
      viewBox="0 0 24 24"
      fill="currentColor"
      aria-hidden="true"
      {...props}
    >
      {cut && (
        <mask id={mask} maskUnits="userSpaceOnUse" x="0" y="0" width="24" height="24">
          <rect width="24" height="24" fill="white" />
          <g
            fill="none"
            stroke="black"
            strokeWidth="2"
            strokeLinecap="round"
            strokeLinejoin="round"
          >
            {cut}
          </g>
        </mask>
      )}
      <g mask={cut ? `url(#${mask})` : undefined}>{children}</g>
    </svg>
  )
}

/** Thick strokes in the current color, for the parts of a glyph that are bars rather than areas. */
const Bar = ({ d, width = 2.6 }: { d: string; width?: number }): React.JSX.Element => (
  <path d={d} fill="none" stroke="currentColor" strokeWidth={width} strokeLinecap="round" />
)

export const SolidFolderIcon = (p: GlyphProps): React.JSX.Element => (
  <Solid {...p}>
    <path d="M2.5 6.5A2.5 2.5 0 0 1 5 4h4.3l2.2 2.2H19a2.5 2.5 0 0 1 2.5 2.5v8.8A2.5 2.5 0 0 1 19 20H5a2.5 2.5 0 0 1-2.5-2.5z" />
  </Solid>
)

export const SolidGlobeIcon = (p: GlyphProps): React.JSX.Element => (
  <Solid
    {...p}
    cut={
      <path
        strokeWidth="1.6"
        d="M2.5 12h19M12 2.5c-3.6 3.2-3.6 15.8 0 19M12 2.5c3.6 3.2 3.6 15.8 0 19"
      />
    }
  >
    <circle cx="12" cy="12" r="9.5" />
  </Solid>
)

export const SolidTerminalIcon = (p: GlyphProps): React.JSX.Element => (
  <Solid {...p} cut={<path d="m7.5 9.5 3 2.5-3 2.5M13 15h3.5" />}>
    <rect x="2.5" y="4" width="19" height="16" rx="3" />
  </Solid>
)

export const SolidBookIcon = (p: GlyphProps): React.JSX.Element => (
  <Solid {...p} cut={<path strokeWidth="1.8" d="M9 7.5h7" />}>
    <path d="M4 5a3 3 0 0 1 3-3h13v15.5H7.2A3.2 3.2 0 0 0 4 20.2z" />
    <path d="M7.2 19H20v3H7.2a1.5 1.5 0 0 1 0-3z" />
  </Solid>
)

export const SolidChatIcon = (p: GlyphProps): React.JSX.Element => (
  <Solid {...p}>
    <path d="M21.5 11.5a9 9 0 0 1-13 8l-5 1.3 1.3-4.7A9 9 0 1 1 21.5 11.5z" />
  </Solid>
)

export const SolidWrenchIcon = (p: GlyphProps): React.JSX.Element => (
  <Solid {...p}>
    <Bar width={4.2} d="M19.3 7.6A3.6 3.6 0 1 1 16.4 4.7" />
    <Bar width={3.6} d="M13.6 10.4 5.4 18.6" />
  </Solid>
)

export const SolidShieldIcon = (p: GlyphProps): React.JSX.Element => (
  <Solid {...p} cut={<path d="m8.5 12 2.5 2.5 4.5-5" />}>
    <path d="M12 2 4 5.2v6.3c0 4.9 3.4 8.9 8 10.5 4.6-1.6 8-5.6 8-10.5V5.2z" />
  </Solid>
)

export const SolidGaugeIcon = (p: GlyphProps): React.JSX.Element => (
  <Solid {...p} cut={<path strokeWidth="2.2" d="m12 15.5 3.8-5.3" />}>
    <path d="M2.5 16.5a9.5 9.5 0 1 1 19 0 2 2 0 0 1-2 2h-15a2 2 0 0 1-2-2z" />
  </Solid>
)

export const SolidPencilIcon = (p: GlyphProps): React.JSX.Element => (
  <Solid {...p} cut={<path strokeWidth="1.6" d="m13.6 6.6 3.8 3.8" />}>
    <path d="m3 21 1.2-5.2L15.4 4.6a2.6 2.6 0 0 1 3.7 0l.3.3a2.6 2.6 0 0 1 0 3.7L8.2 19.8z" />
  </Solid>
)

export const SolidLockIcon = (p: GlyphProps): React.JSX.Element => (
  <Solid {...p} cut={<path strokeWidth="2.2" d="M12 14.5v3" />}>
    <Bar d="M7.6 10.5V7.6a4.4 4.4 0 0 1 8.8 0v2.9" />
    <rect x="4" y="10" width="16" height="12" rx="2.5" />
  </Solid>
)
