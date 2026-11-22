---
name: customize-look
description: Change how Barebone itself looks and is laid out, when the user asks (colors, fonts, sizes, spacing, hiding or moving parts, a different layout, the chat's messages, tool calls and composer, icons, the window's buttons, a translucent window). Covers the look.css and look.json files Barebone reloads on save, its design tokens, light and dark, the remote link's pages, checking the result with see_app, and how the user undoes it.
---

# Changing Barebone's look

Barebone's whole interface is a web page, and you change it with two files that Barebone reads again the moment they are saved:

- `look.css`: a stylesheet that comes after all of Barebone's own. It can restyle and rearrange anything a stylesheet can: colors, fonts, sizes, spacing, corners, shadows, hiding parts, reordering them, a different layout (the sidebar on the right, a wider chat, a compact top bar).
- `look.json`: the Mac window's chrome that no stylesheet reaches. That means where the window's buttons sit, whether they show, and a translucent material behind the window.

Both live in Barebone's `look` folder, which is `~/Library/Application Support/Barebone/look/` on a Mac. The first lines of `see_app`'s answer give the exact paths and say whether each file exists. Create the folder and files when they don't exist yet.

## How to work

1. Call `see_app` first. It returns a picture of the window and an outline of its parts with their tags, classes, titles and sizes. Pick selectors from the outline, never from memory: class names change between versions. Call it with `part` (a CSS selector) to see one part in depth with its computed styles, and with `tokens: true` to list the design tokens and their values.
2. Read the files as they are. The user may have a look already, and you keep what they asked for before unless they say otherwise. Put a short comment above each block saying what it does (`/* Sidebar on the right */`), so the next change can find it.
3. Make the change with your file tools. Change tokens first (see below), and selectors only where tokens don't reach.
4. Call `see_app` again and look at the picture. Check the part you changed and what is around it. A change often breaks something next to it, like a bar overlapping the window's buttons or text unreadable on a new background. Fix and check again.
5. Tell the user what you changed, which theme you checked it in (`see_app` shows the current one), and how to undo it: Settings → Custom look has a switch and a Reset button, which moves the files to the Trash, and View → Custom Look in the menu bar turns the look off even when the page is broken.

## Tokens

Every color, shadow, corner and the main sizes are CSS variables on `:root` (`see_app` with `tokens: true` lists all of them). Changing one changes every part that uses it, and that holds up best across Barebone updates. Some of the main ones:

- Backgrounds: `--canvas` (behind everything), `--panel` (the sidebar and side panels), `--panel-main` (the chat).
- Text: `--text`, `--text-soft`, `--text-muted`.
- Accent: `--accent`, `--accent-hover`, `--accent-text`, `--accent-soft`.
- Lines and fills: `--border`, `--border-strong`, `--fill`, `--hover`, `--selected`.
- The user's messages: `--bubble`, `--bubble-text`.
- The send key: `--key`, `--key-text`.
- Sizes: `--sidebar-width`, `--chat-width`, `--radius-sm` to `--radius-xl`.
- Monospace type: `--mono`.

Light and dark: Barebone's dark values sit in `@media (prefers-color-scheme: dark) { :root { … } }`. A token you set in a plain `:root` rule applies in both themes, because your sheet comes last. To change a color in one theme only, put it inside that media query, or inside `@media (prefers-color-scheme: light)`. When the user asks for a color scheme, give it values for both themes unless they want one look for both.

```css
/* Warmer accent, in both themes */
:root {
  --accent: #d9480f;
  --accent-hover: #c2410c;
  --accent-text: #c2410c;
}

/* A deep blue background in dark only */
@media (prefers-color-scheme: dark) {
  :root {
    --canvas: #0b1220;
    --panel: #0b1220;
    --panel-main: #0f172a;
  }
}
```

## Layout

The window is a row: `.app` (flex) holds `.sidebar`, then `.main` (the chat, with `.topbar` on top and the composer at the bottom), then a `.side-panel` when the browser or code panel is open. Inside them, use `see_app` to find the parts. A rule of yours wins over Barebone's at the same specificity because it comes later, so match its selector and you need no `!important`. The exception is a part whose size the app sets inline, like the side panels' width, which `see_app` shows as an inline style. There, use `!important`.

```css
/* Sidebar on the right */
.sidebar {
  order: 2;
}
.side-panel {
  order: 1;
}
```

Things to keep in mind:

- The window's buttons sit over the top left of the window, in the sidebar's top row. When the layout moves the sidebar or covers that corner, move the buttons with `look.json`, or hide them, and leave room for them. With the buttons hidden, Barebone puts the class `no-window-buttons` on `<html>`, and the top bar stops leaving room for them while the sidebar is hidden.
- The window is dragged by its bars (`-webkit-app-region: drag`, and `no-drag` on each button in them). Keep a bar the user can drag the window by.
- The browser panel's page is a native view drawn over the window at the place of `.browser-viewport`. A stylesheet can move and size that place, and the page follows, but nothing can draw over the page or restyle it, and it is not in `see_app`'s picture.
- Never hide what the user needs to use the app: the composer, the chat list, a way to Settings. If they ask you to hide something, make sure there is still a way to it, and say how.
- Hiding the sidebar (⌘B) gives it the class `closed`, which slides it off to the left with a negative `margin-left`, and gives `.app` the class `sidebar-hidden`. A layout that moves the sidebar elsewhere also needs `.sidebar.closed` changed (a negative `margin-right` for the right side), so hiding still works.

## The chat and small details

Everything in the chat is a page element like the rest, so the same file restyles it. The main parts, to confirm with `see_app` (`part: ".chat-items"` outlines the open chat):

- `.user-msg .bubble`: the user's messages (tokens `--bubble`, `--bubble-text`, `--radius-bubble`).
- `.markdown`: the agent's replies, with ordinary `p`, `h1` to `h3`, `ul`, `a`, `code` and `pre` inside.
- `.activity`: a group of tool calls. `.act-line` is its summary line ("Ran 3 commands"), `.call` one tool call with `.call-verb` and `.call-target`, and `.open` marks a group or call that is expanded. `.thinking-body` is the model's thinking.
- `.turn-work`: a turn's work, open while the agent works and folded into "Worked for 1m 6s" (`.turn-work-head`) once it is done. Permission prompts and the agent's questions (`.ask-card`) sit in it too. To hide tool calls, hide `.activity`, never `.turn-work` or its body: that would hide a prompt the agent is waiting on, and the chat would look stuck.
- `.answer-actions`: the buttons under a reply.
- `.composer`: the message field, a grid with the areas `header`, `leading`, `primary` and `trailing`. Its buttons sit in `.composer-leading` and `.composer-trailing`. `display: contents` on one of those lets each button be placed on its own with `grid-area` or `order`.

Folded parts (a tool call's output, an edited file's diff, a finished turn's work) are only put in the page the first time they are opened, so a stylesheet can hide them or restyle them once open, but can't make them start open.

`see_app` only outlines what the window shows. When the parts you need aren't on screen (no tool calls in the open chat), ask the user to open a chat that has them.

Code in replies is colored word by word by the syntax theme, through `--shiki-light` and `--shiki-dark` on each word. You can restyle code blocks (`.markdown pre`: background, font, size, corners) and make all code one color, but not remap single syntax colors.

### Icons

Most icons are Tabler SVGs drawn in `currentColor`, each with the classes `tabler-icon tabler-icon-<name>`, like `.tabler-icon-settings` or `.tabler-icon-git-branch`. `see_app`'s outline shows each one's name. Recolor one with `color`, resize it with `width` and `height`, and thicken its lines with `stroke-width`. To swap one for another shape, hide its paths and draw the new shape as a mask:

```css
/* A star for Settings */
.tabler-icon-settings > * {
  display: none;
}
.tabler-icon-settings {
  background: currentColor;
  -webkit-mask: url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 24 24'%3E%3Cpath d='M12 2l3 7h7l-5.5 4.5 2 7.5-6.5-4.5-6.5 4.5 2-7.5L2 9h7z'/%3E%3C/svg%3E")
    center / contain no-repeat;
}
```

An icon without a `tabler-icon-` class is the app's own; select it through the button it sits in, by the button's title: `button[title^="New chat"] svg`.

## The remote link

The same `look.css` styles the remote link's pages, Barebone in a phone's or another computer's browser. There `<html>` has the class `remote`, and on a phone the layout is different (sheets from the bottom, controls where the thumb reaches). Scope a change that is meant for the Mac window only with `html:not(.remote)`, and one for the remote pages with `html.remote`. `see_app` only shows the Mac window, so for a remote-only change tell the user to check it on their phone.

## look.json

```json
{
  "windowButtons": { "x": 16, "y": 17 },
  "vibrancy": "sidebar"
}
```

- `windowButtons`: where the close, minimize and zoom buttons sit, in points from the window's top left (Barebone's own place is `{"x": 16, "y": 17}`), or `false` to hide them. With them hidden the window still closes with ⌘W and the menu bar.
- `vibrancy`: a macOS material behind the window: `sidebar`, `under-window`, `window`, `content`, `header`, `titlebar`, `menu`, `popover`, `hud`, `sheet`, `fullscreen-ui`, `tooltip`, `selection` or `under-page`. It shows only where the page is transparent, so set the backgrounds you want it behind to `transparent` or a see-through color in `look.css` (for a translucent sidebar: `--panel` and the `.sidebar` background).

A vibrancy needs a window made see-through as it opens, so adding or removing one takes effect only when the user quits Barebone (⌘Q) and opens it again; `see_app` says when that is due. Tell the user so, and that a see-through window has no shadow around it. Changing from one material to another while a vibrancy is on applies at once. `see_app`'s picture can't show the material: it shows the window as if nothing were behind it, so describe the result instead of judging it from the picture, and ask the user how it looks.

Leave a setting out to keep Barebone's own. `see_app` lists any problem with the file, like invalid JSON or an unknown setting. These settings only apply to the Mac window.

## What it can't do

The look changes how the existing interface is drawn and arranged. It can't add new buttons, panels or behavior, or run scripts. For that, Barebone's own code has to change. Tell the user, and offer to change it in Barebone's source if they have it.

It loads nothing from the web either: the pages' security policy blocks `@import`, web fonts and, on the remote pages, images from other sites. Use fonts installed on the computer (`font-family: "Avenir Next", system-ui`), and draw backgrounds with gradients, or `data:` URLs for small images.
