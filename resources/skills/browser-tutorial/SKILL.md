---
name: browser-tutorial
description: Teach or explain something on a web page in the Barebone browser by drawing on it - boxes, arrows, a pointer and captions - and wait for the user's clicks. Use when the user asks for a tutorial, a walkthrough, a guided tour, "show me how", "where do I click", or an explanation of a page or of HTML you generated.
---

# Browser tutorial

The browser tools `show_step`, `annotate`, `point`, `caption` and `clear_annotations` draw on the page in the user's browser panel, and `wait_for_click` tells you what the user clicked. The user watches the panel while you work, so every reply you wait for is time they wait too: show each step in one call, not several. Drawings don't take clicks and don't show in snapshots. They stay until you clear them or the page navigates.

## Before drawing

1. Open the page with `navigate`. To explain HTML you made, write it to a file first and open its `file://` URL.
2. Take a `snapshot` to get refs. Draw on elements by `ref` whenever you can, because those drawings follow the element when the page scrolls. Use `x` and `y` from the latest screenshot only for things with no ref, such as a canvas or an image area.
3. Plan the steps before you draw. A step is one idea: one thing to look at or one thing to do.

## One step

Show a step with one `show_step` call:

- `caption` says what the step is about in a sentence or two, like "Step 2 of 4: pick a plan".
- `point` moves the pointer to the element the step is about, with a short instruction in its `text`, like "Click Upgrade".
- `shapes` adds at most two or three: a `box` around the area that matters, or an `arrow` toward something small. Give each a short label when it helps. Detail that doesn't fit in a label or the caption goes in the chat.

It removes the shapes of the step before. Its result says whether anything is in the way: a target that is hidden or off the page, or the caption or a label covering one. Fix what it names with another `show_step`; there is no need to take a screenshot to check. The caption moves to the top by itself when at the bottom it would cover a target.

To tell the user the step out loud, give `show_step` a `say` (it is there when the voice is on) rather than calling `speak`. The step then shows as the voice begins, after anything said before it, and your next change to the page (a click, the next step, clearing) waits until the voice has said it, so what they see matches what they hear. Then call `wait_for_click`; it starts listening at once, while the voice talks. A step is two replies: show it, then wait.

## Pacing

- **Step by step** (the default for "teach me" or "walk me through"): show one step, then call `wait_for_click` with the ref the user should click. When the click comes back:
  - It was the right element: say so in the caption ("That's it.") and show the next step.
  - It was something else: point at the right element again, and say in the caption what they clicked instead.
  - No click before the wait ended: call `wait_for_click` again. After two or three empty waits, ask in the chat whether they're stuck.
  - The page changed: take a snapshot and continue from what is shown now.

  When a step has nothing to click (reading, typing), end your turn with a one-line chat message instead, such as "Say next when you're ready."
- **Demo**: do the steps yourself only when the user asks you to show them. Point at each element and caption it, then click it.
- **Overview** (for "explain this page" or "what is all this"): draw everything at once with one `annotate` call. Use numbered box labels ("1", "2", ...) and explain each number in your chat reply.

## Video

For a narrated video of a walkthrough or demo (`start_recording` is there when recording is on in Settings):

1. Open the page, take a snapshot, and plan the steps before you record.
2. Call `start_recording`.
3. For each step, make one `show_step` call with `say` and a `point` on the element, then do the step yourself (`click`, `type`). Leave out `caption` when `say` already tells the step. The click waits until the voice is done, so what the video shows matches what it says.
4. Call `stop_recording`. It waits for the last words.

The video pauses while you work out the next step, so take your time. All the narration goes in `say`: don't call `speak` alongside it, and never make audio with another voice or add sound to the file afterwards. Don't take screenshots to check a step, because its result already says what's in the way.

### Demos and launch videos

When the user wants a video to show off or share (a demo, a launch video, a feature reveal), plan it before you record:

1. **Storyboard first.** Write the scenes down with a length each: a hook (2–3 s), a reveal (2–4 s), two or three highlights, and an ending with the name or the result (2–4 s). A launch video is 15–25 seconds; a demo of a flow can run longer, but no scene runs without a reason.
2. **The hook is everything.** The first two seconds decide whether anyone keeps watching. Open on the most striking thing the product does, not on a logo or a menu.
3. **Show the real thing.** Use the actual app or page doing its job: entry, the key action, the result. Use its own words and claims, never generic ones like "streamline your workflow". Never invent numbers, quotes or features.
4. **Readable.** Every line meant to be read stays on screen, fully in, for about 0.3 s per word. Pace comes from cuts and motion, not from text that leaves early.
5. **Voice and mood.** Keep each `say` to a sentence or two that adds to the picture instead of reading what's on screen. When `say` takes a `mood`, match it to the moment: excited for the reveal, calm for a detail, proud for the ending.
6. **Music.** With `make_music`, make a simple track that fits the tone (20–40 s; the video loops it) and give its path to `start_recording`'s `music`. It plays under the voice and ducks while the voice talks. Leave music out of walkthroughs and bug reports.
7. **Thumbnail.** With `mark_thumbnail`, mark the strongest settled moment, with the name or the result fully on screen, as the video's thumbnail. `stop_recording` says where it saved it.
8. **Check it.** Before you tell the user, read `stop_recording`'s result: the length should match the storyboard.

### Animated videos

For titles, motion graphics or a video of something that has no page yet, build the scene as a page and record it:

1. Write one HTML file with the scenes as CSS or Web Animations, at a fixed size such as 1920×1080. Nothing moves on load: a `start()` function plays the whole thing from the beginning, and every scene's timing comes from it.
2. Use real assets: the product's own colors, fonts, logo and screenshots, copied next to the file. No scripts or media from the web.
3. `set_viewport` to the scene's size, `navigate` to the file's `file://` URL, then `start_recording`.
4. Call `play` with `run: "start()"` and the scene's length in seconds. Recording pauses while you work, so only `play` puts a moving page in the video. For narration over it, call `speak` (with a `mood`) just before `play`; it plays over the animation.
5. `mark_thumbnail` at the strongest moment if you can time it (call `play` in parts), then `stop_recording`.

## Writing on the page

- Keep page text short. A label is a few words and a caption is at most two sentences. Put longer explanations in the chat.
- Use one color for the main path, plus a second color for warnings or "not this one".
- Write what the user sees and does: "Click Save", not "Interact with the persistence control".

## Rules

- `point` only shows where to look. It doesn't click. Only click, type or submit for the user when they asked you to.
- When the tutorial ends, call `clear_annotations`, unless the user wants to keep the drawings up.
