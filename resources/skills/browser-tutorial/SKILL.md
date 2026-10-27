---
name: browser-tutorial
description: Teach or explain something on a web page in the Barebone browser by drawing on it - boxes, arrows, a pointer and captions - and wait for the user's clicks. Use when the user asks for a tutorial, a walkthrough, a guided tour, "show me how", "where do I click", or an explanation of a page or of HTML you generated.
---

# Browser tutorial

The browser tools `annotate`, `point`, `caption` and `clear_annotations` draw on the page in the user's browser panel, and `wait_for_click` tells you what the user clicked. The user watches the panel while you work. Drawings don't take clicks and don't show in snapshots. They stay until you clear them or the page navigates.

## Before drawing

1. Open the page with `navigate`. To explain HTML you made, write it to a file first and open its `file://` URL.
2. Take a `snapshot` to get refs. Draw on elements by `ref` whenever you can, because those drawings follow the element when the page scrolls. Use `x` and `y` from the latest screenshot only for things with no ref, such as a canvas or an image area.
3. Plan the steps before you draw. A step is one idea: one thing to look at or one thing to do.

## One step

1. `caption` says what this step is about in a sentence or two, like "Step 2 of 4: pick a plan".
2. `point` moves the pointer to the element the step is about. Its `text` is a short instruction, like "Click Upgrade".
3. `annotate` adds at most two or three shapes: a `box` around the area that matters, or an `arrow` toward something small. Give each a short label when it helps. Detail that doesn't fit in a label or the caption goes in the chat.
4. Take a `screenshot` and check the drawings: they mark the right thing, nothing covers what they explain, and the text is readable. If something is off, use `clear: true` on the next `annotate` and draw again.

Start the next step with `annotate` and `clear: true`, so old shapes don't pile up. The pointer and the caption move or change when you call them again.

## Pacing

- **Step by step** (the default for "teach me" or "walk me through"): show one step, then call `wait_for_click` with the ref the user should click. When the click comes back:
  - It was the right element: say so in the caption ("That's it.") and show the next step.
  - It was something else: point at the right element again, and say in the caption what they clicked instead.
  - No click before the wait ended: call `wait_for_click` again. After two or three empty waits, ask in the chat whether they're stuck.
  - The page changed: take a snapshot and continue from what is shown now.

  When a step has nothing to click (reading, typing), end your turn with a one-line chat message instead, such as "Say next when you're ready."
- **Demo**: do the steps yourself only when the user asks you to show them. Point at each element and caption it, then click it.
- **Overview** (for "explain this page" or "what is all this"): draw everything at once. Use numbered box labels ("1", "2", ...) and explain each number in your chat reply.

## Writing on the page

- Keep page text short. A label is a few words and a caption is at most two sentences. Put longer explanations in the chat.
- Use one color for the main path, plus a second color for warnings or "not this one".
- Write what the user sees and does: "Click Save", not "Interact with the persistence control".

## Rules

- `point` only shows where to look. It doesn't click. Only click, type or submit for the user when they asked you to.
- When the tutorial ends, call `clear_annotations`, unless the user wants to keep the drawings up.
