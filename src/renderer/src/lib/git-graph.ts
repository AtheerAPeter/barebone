import type { GitCommit, GitLog } from '../../../shared/types'

/**
 * The lanes of the code panel's commit graph, as VS Code's Source Control
 * Graph lays them out (src/vs/workbench/contrib/scm/browser/scmHistory.ts,
 * MIT): each row has the lanes coming in from the row above and the lanes
 * going out to the row below, each lane waiting for one commit.
 */

export interface Lane {
  /** The commit this lane leads to. */
  id: string
  color: string
}

export interface GraphRow {
  commit: GitCommit
  head: boolean
  input: Lane[]
  output: Lane[]
}

export const LANE_WIDTH = 11
export const ROW_HEIGHT = 22
const CURVE = 5
const DOT = 4

/** Branch lanes take these in turn; the checked-out branch and its upstream have their own. */
const COLORS = [
  'var(--graph-1)',
  'var(--graph-2)',
  'var(--graph-3)',
  'var(--graph-4)',
  'var(--graph-5)'
]
export const BRANCH_COLOR = 'var(--graph-branch)'
export const UPSTREAM_COLOR = 'var(--graph-upstream)'

/** The color of the checked-out branch's and its upstream's lanes, by ref. */
export function refColors(log: GitLog): Map<string, string> {
  const colors = new Map<string, string>()
  if (log.branch) colors.set(log.branch, BRANCH_COLOR)
  if (log.upstream) colors.set(log.upstream, UPSTREAM_COLOR)
  return colors
}

function labelColor(commit: GitCommit, colors: Map<string, string>): string | undefined {
  for (const ref of commit.refs) {
    const color = colors.get(ref.id)
    if (color) return color
  }
  return undefined
}

export function graphRows(log: GitLog): GraphRow[] {
  const colors = refColors(log)
  const rows: GraphRow[] = []
  let next = -1
  for (const commit of log.commits) {
    const input = rows.at(-1)?.output.map((lane) => ({ ...lane })) ?? []
    const output: Lane[] = []
    let firstParentAdded = false

    // The lane that led here goes on to the first parent; the other lanes pass by.
    if (commit.parents.length > 0) {
      for (const lane of input) {
        if (lane.id === commit.hash) {
          if (!firstParentAdded) {
            output.push({ id: commit.parents[0], color: labelColor(commit, colors) ?? lane.color })
            firstParentAdded = true
          }
          continue
        }
        output.push({ ...lane })
      }
    }

    // Parents no lane leads to yet get new lanes: a merge's other parents, or a new tip's first.
    for (let i = firstParentAdded ? 1 : 0; i < commit.parents.length; i++) {
      let color: string | undefined
      if (i === 0) color = labelColor(commit, colors)
      else {
        const parent = log.commits.find((c) => c.hash === commit.parents[i])
        color = parent && labelColor(parent, colors)
      }
      if (!color) {
        next = (next + 1) % COLORS.length
        color = COLORS[next]
      }
      output.push({ id: commit.parents[i], color })
    }

    rows.push({ commit, head: commit.hash === log.head, input, output })
  }
  return rows
}

/** A row's lane in which its commit's dot sits, and the dot's color. */
export function dotOf(row: GraphRow): { index: number; color: string } {
  const inputIndex = row.input.findIndex((lane) => lane.id === row.commit.hash)
  const index = inputIndex !== -1 ? inputIndex : row.input.length
  const color =
    index < row.output.length
      ? row.output[index].color
      : index < row.input.length
        ? row.input[index].color
        : BRANCH_COLOR
  return { index, color }
}

/** A row's lines, as SVG paths: the lanes through it, into its dot and out to its parents. */
export function rowPaths(row: GraphRow): { d: string; color: string }[] {
  const W = LANE_WIDTH
  const H = ROW_HEIGHT
  const paths: { d: string; color: string }[] = []
  const { index: dot, color: dotColor } = dotOf(row)
  const inputIndex = row.input.findIndex((lane) => lane.id === row.commit.hash)

  let out = 0
  for (let index = 0; index < row.input.length; index++) {
    const { id, color } = row.input[index]
    if (id === row.commit.hash) {
      // Another lane that led to this commit too, as a branch's base: it bends into the dot.
      if (index !== dot) {
        paths.push({
          d: `M ${W * (index + 1)} 0 A ${W} ${W} 0 0 1 ${W * index} ${W} H ${W * (dot + 1)}`,
          color
        })
      } else out++
      continue
    }
    if (out < row.output.length && id === row.output[out].id) {
      if (index === out) paths.push({ d: `M ${W * (index + 1)} 0 V ${H}`, color })
      else {
        // A lane that moves over to the left, where one ended.
        paths.push({
          d:
            `M ${W * (index + 1)} 0 V 6 ` +
            `A ${CURVE} ${CURVE} 0 0 1 ${W * (index + 1) - CURVE} ${H / 2} ` +
            `H ${W * (out + 1) + CURVE} ` +
            `A ${CURVE} ${CURVE} 0 0 0 ${W * (out + 1)} ${H / 2 + CURVE} V ${H}`,
          color
        })
      }
      out++
    }
  }

  // A merge's other parents, off to the side.
  for (let i = 1; i < row.commit.parents.length; i++) {
    const parent = lastIndex(row.output, row.commit.parents[i])
    if (parent === -1) continue
    paths.push({
      d:
        `M ${W * parent} ${H / 2} A ${W} ${W} 0 0 1 ${W * (parent + 1)} ${H} ` +
        `M ${W * parent} ${H / 2} H ${W * (dot + 1)}`,
      color: row.output[parent].color
    })
  }

  if (inputIndex !== -1) {
    paths.push({ d: `M ${W * (dot + 1)} 0 V ${H / 2}`, color: row.input[inputIndex].color })
  }
  if (row.commit.parents.length > 0) {
    paths.push({ d: `M ${W * (dot + 1)} ${H / 2} V ${H}`, color: dotColor })
  }
  return paths
}

/** How wide a row's graph is: room for all its lanes. */
export function rowWidth(row: GraphRow): number {
  return LANE_WIDTH * (Math.max(row.input.length, row.output.length, 1) + 1)
}

export const DOT_RADIUS = DOT

function lastIndex(lanes: Lane[], id: string): number {
  for (let i = lanes.length - 1; i >= 0; i--) if (lanes[i].id === id) return i
  return -1
}
