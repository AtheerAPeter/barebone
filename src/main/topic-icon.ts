/**
 * A chat's topic icon: the Tabler icon (the set the renderer already draws
 * with) whose name and tags best match what the chat is about, so chats can
 * be told apart at a glance. Matching is local and needs no model: the words
 * of the chat's title and first message are scored against each icon's name
 * and tags, rarer words counting for more (tf-idf), the title most.
 */

/** An entry of @tabler/icons/icons.json (aliased as tabler-icons-meta). */
export interface TablerIcon {
  name: string
  category: string
  tags: (string | number)[]
}

/** Shown when nothing in the chat matches an icon well enough. */
export const FALLBACK_ICON = 'message'

/**
 * Categories whose icons stand for a glyph, not a topic: letters and numbers
 * ("a", "1"), arrows and plain shapes, laundry and zodiac signs. Their tags
 * are words like "up", "one" or "circle" that would match almost any chat.
 */
const SKIPPED_CATEGORIES = new Set([
  'Letters',
  'Numbers',
  'Arrows',
  'Shapes',
  'Laundry',
  'Zodiac',
  'Gender'
])

/**
 * Words that say nothing about a topic: common English, and the verbs a
 * request starts with ("open", "build me", "list my"), which say what to do,
 * not what it is about.
 */
const STOPWORDS = new Set(
  `a about above after again against all already also am an and any are aren as at be because been
  before being below between both but by can cannot could did do does doing don done down during each
  else even ever every few for from further get gets getting give go goes going gonna got had has have
  having he her here hers herself him himself his how however i if in into is isn it its itself just
  let lets like ll make makes making me might more most much must my myself need needs no nor not now
  of off ok okay on once one only or other our ours ourselves out over own please pls put re really
  same see seem she should so some something still such sure take than thank thanks that the their
  theirs them themselves then there these they thing things this those though through to too try
  trying under until up us use used using ve very want wanna wants was we well were what when where
  whether which while who whom why will with without would yeah yes yet you your yours yourself
  yourselves hi hello hey new way can't i'm it's don't doesn't didn't isn't let's
  look looks looking show tell know think help work works working thing kind lot bit little
  good great nice better best bad fine able via etc maybe also again
  open find add list create build write explore continue start check read run do
  task group step part phase right left`.split(/\s+/)
)

/**
 * Words that Tabler's tags miss or that mean something else in software work,
 * each with words of the tags that find the right icon ("flaky" a bug, "ship"
 * a rocket). They are matched as if the chat had said them too, so they count
 * by how rare they are like any other word.
 */
const SYNONYMS = new Map<string, string[]>(
  Object.entries({
    crash: ['bug'],
    broken: ['bug'],
    regression: ['bug'],
    flaky: ['bug'],
    compile: ['hammer'],
    ship: ['rocket'],
    publish: ['rocket'],
    refactor: ['tool'],
    cleanup: ['tool'],
    commit: ['git'],
    branch: ['git'],
    merge: ['git'],
    rebase: ['git'],
    pr: ['git', 'pull', 'request'],
    ui: ['layout'],
    ux: ['layout'],
    css: ['palette'],
    styling: ['palette'],
    redesign: ['palette'],
    db: ['database'],
    sql: ['database'],
    auth: ['lock'],
    signin: ['login'],
    password: ['key'],
    docs: ['book'],
    documentation: ['book'],
    readme: ['book'],
    perf: ['gauge'],
    performance: ['gauge'],
    slow: ['gauge'],
    latency: ['gauge'],
    agent: ['robot'],
    bot: ['robot'],
    ai: ['sparkles'],
    llm: ['brain'],
    prompt: ['terminal'],
    cli: ['terminal'],
    shell: ['terminal'],
    plugin: ['plug'],
    extension: ['puzzle'],
    skill: ['puzzle'],
    localhost: ['browser'],
    website: ['world'],
    web: ['world'],
    site: ['world'],
    url: ['link'],
    game: ['gamepad'],
    shooter: ['gamepad'],
    racing: ['car'],
    apartment: ['building'],
    flat: ['building'],
    rent: ['home'],
    rental: ['home'],
    listing: ['home'],
    poem: ['feather'],
    poetry: ['feather'],
    story: ['book'],
    ios: ['mobile'],
    iphone: ['mobile'],
    android: ['mobile'],
    simulator: ['mobile'],
    emulator: ['mobile'],
    speech: ['microphone'],
    tts: ['volume'],
    screenshot: ['camera'],
    meeting: ['users'],
    marketing: ['speakerphone'],
    seo: ['search'],
    analytics: ['chart'],
    invoice: ['receipt'],
    pricing: ['coin'],
    payment: ['credit', 'card'],
    checkout: ['cart'],
    email: ['mail'],
    gmail: ['mail'],
    schedule: ['calendar'],
    translate: ['language'],
    translation: ['language'],
    autocomplete: ['keyboard'],
    update: ['refresh'],
    upgrade: ['refresh'],
    install: ['download'],
    revert: ['history'],
    undo: ['history'],
    notification: ['bell'],
    permission: ['shield'],
    security: ['shield'],
    slides: ['presentation'],
    whiteboard: ['board'],
    job: ['briefcase']
  })
)

/** How much a word counts when it is part of an icon's name, and when it is one of its tags. */
const NAME_WEIGHT = 3
const TAG_WEIGHT = 1
/** The title says what the chat is about more than its first message does. */
const TITLE_WEIGHT = 3
const BODY_WEIGHT = 1
/** Only the start of a long first message is read: it says what is asked; the rest is detail. */
const BODY_WORDS = 120
/**
 * Each part of an icon's name the chat does not mention makes it a little
 * less likely, so "rocket" wins over "rocket-off" when the chat says "rocket".
 */
const UNMATCHED_PART = 0.8
/** Below this score a match is a coincidence of common words; the chat gets FALLBACK_ICON. */
const MIN_SCORE = 2.5

/**
 * A plural's singular, so "tests" matches "test" and "batteries" "battery".
 * Only plurals: cutting "-ing" or "-ed" turns "string" into "str" and
 * "speed" into "spe", and Tabler's tags list the verb forms that matter.
 */
export function stem(word: string): string {
  if (word.length > 4 && word.endsWith('ies')) return word.slice(0, -3) + 'y'
  if (word.length > 4 && /(ches|shes|sses|xes)$/.test(word)) return word.slice(0, -2)
  if (word.length > 3 && word.endsWith('s') && !/(ss|us|is)$/.test(word)) return word.slice(0, -1)
  return word
}

/**
 * A text's words, lowercased, without URLs, file paths and file names, whose
 * parts ("users", "src", "js") name no topic. A slash command
 * ("/video-producer") is kept: its words say what the chat is for.
 */
function words(text: string): string[] {
  return text
    .toLowerCase()
    .replace(/\b[a-z]+:\/\/\S+/g, ' ')
    .replace(/[~.]?\/?[^\s/]+\/[^\s/]+\/\S*/g, ' ')
    .replace(/\b[\w-]+\.[a-z0-9]{1,5}\b/g, ' ')
    .split(/[^a-z0-9']+/)
    .map((w) => w.replace(/^'+|'+$/g, ''))
    .filter((w) => w.length > 1 && !/^\d+$/.test(w) && !STOPWORDS.has(w))
}

interface Posting {
  icon: number
  weight: number
}

export interface TopicIndex {
  names: string[]
  /** Each icon's name split into its stemmed parts. */
  parts: string[][]
  /** For each stemmed term, the icons it appears in and how strongly. */
  postings: Map<string, Posting[]>
}

/** Index the icons' names and tags by stemmed term, once. */
export function buildIndex(icons: Iterable<TablerIcon>): TopicIndex {
  const names: string[] = []
  const parts: string[][] = []
  const postings = new Map<string, Posting[]>()
  for (const icon of icons) {
    if (SKIPPED_CATEGORIES.has(icon.category)) continue
    const index = names.length
    const nameParts = icon.name.split('-').map(stem)
    names.push(icon.name)
    parts.push(nameParts)
    const terms = new Map<string, number>()
    const add = (term: string, weight: number): void => {
      if (term && (terms.get(term) ?? 0) < weight) terms.set(term, weight)
    }
    for (const part of nameParts) add(part, NAME_WEIGHT)
    // A brand's tags list what the company does ("code", "hosting"); only its name says it is that brand.
    if (icon.category !== 'Brand') {
      for (const tag of icon.tags) {
        const text = String(tag).toLowerCase()
        add(text, TAG_WEIGHT)
        for (const word of text.split(/[^a-z0-9]+/)) {
          if (word && !STOPWORDS.has(word)) add(stem(word), TAG_WEIGHT)
        }
      }
    }
    for (const [term, weight] of terms) {
      let list = postings.get(term)
      if (!list) postings.set(term, (list = []))
      list.push({ icon: index, weight })
    }
  }
  return { names, parts, postings }
}

/** The chat's terms, each with how much it counts. */
function queryTerms(title: string, body: string): Map<string, number> {
  const terms = new Map<string, number>()
  const add = (term: string, weight: number): void => {
    terms.set(term, Math.max(terms.get(term) ?? 0, weight))
  }
  const read = (list: string[], weight: number): void => {
    list.forEach((word, i) => {
      const term = stem(word)
      // Two letters are an abbreviation ("hd", "fx") that matches badges and marks by
      // chance; one counts only through its synonyms ("ui", "db", "pr").
      if (term.length > 2) add(term, weight)
      // Two words that are one tag together ("dark mode" is tagged "dark-mode").
      if (i > 0) add(`${list[i - 1]}-${word}`, weight)
      for (const synonym of SYNONYMS.get(term) ?? []) add(stem(synonym), weight)
    })
  }
  read(words(body).slice(0, BODY_WORDS), BODY_WEIGHT)
  read(words(title), TITLE_WEIGHT)
  return terms
}

/** The name of the icon that best matches a chat's title and first message. */
export function matchTopic(index: TopicIndex, title: string, body = ''): string {
  const total = index.names.length
  const scores = new Map<number, number>()
  const matched = new Map<number, Set<string>>()
  for (const [term, weight] of queryTerms(title, body)) {
    const list = index.postings.get(term)
    if (!list) continue
    // A word on few icons says more than one on hundreds.
    const idf = Math.log(1 + total / list.length)
    for (const posting of list) {
      scores.set(posting.icon, (scores.get(posting.icon) ?? 0) + weight * posting.weight * idf)
      let set = matched.get(posting.icon)
      if (!set) matched.set(posting.icon, (set = new Set()))
      set.add(term)
    }
  }
  let best = -1
  let bestScore = 0
  for (const [icon, raw] of scores) {
    const terms = matched.get(icon)!
    const unmatched = index.parts[icon].filter((part) => !terms.has(part)).length
    const score = raw * UNMATCHED_PART ** unmatched
    // Ties go to the plainer icon: fewer name parts, then the shorter name.
    if (
      score > bestScore ||
      (score === bestScore &&
        best >= 0 &&
        (index.parts[icon].length < index.parts[best].length ||
          (index.parts[icon].length === index.parts[best].length &&
            index.names[icon].length < index.names[best].length)))
    ) {
      best = icon
      bestScore = score
    }
  }
  return best >= 0 && bestScore >= MIN_SCORE ? index.names[best] : FALLBACK_ICON
}

let loaded: Promise<TopicIndex> | undefined

/**
 * The icon for a chat with this title and first message. Tabler's 2 MB list
 * of icons and tags is read on the first call, not at launch.
 */
export function topicIcon(title: string, body = ''): Promise<string> {
  loaded ??= import('tabler-icons-meta').then((meta) => buildIndex(Object.values(meta.default)))
  return loaded.then((index) => matchTopic(index, title, body))
}
