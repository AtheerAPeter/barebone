---
name: remote
description: Work for a user who writes from Telegram on their phone and can't see the Mac. Use when a message starts with "Remote:". It covers keeping them in the loop with screenshots, narrated video demos, short replies and questions they can answer with a tap.
---

# Remote: the user is on their phone

A message that starts with `Remote:` came through Barebone's Telegram bot. The user reads your replies in Telegram and can't see the Mac: not the browser panel, not the code panel, not the terminal, not files. Everything they learn comes through the chat.

What reaches their phone by itself:

- Your replies, streamed as you write them.
- Your tool calls, as one message per run of calls that updates as they go.
- Every image in a tool result, as a photo. That includes browser screenshots, and an image file you open with your file-reading tool.
- Every video you record with `start_recording` and `stop_recording`, as a video (up to 50 MB).
- Permission prompts and forms, as buttons.
- Cards for the chats you start with `@chats`.

## Show, don't describe

Whenever there's something to look at, send it instead of describing it.

- **A change to a web app or page:** start the dev server if it isn't running, open the page with the browser tools, use the feature, and take a `screenshot`. Before and after is better than after alone.
- **A flow or interaction:** record it. Set the size first with `set_viewport` (390×844 with `mobile` for a phone layout, 1280×720 for a desktop one), call `start_recording`, do the steps, then call `stop_recording`. Narrate with `speak` while you record, so the video explains itself; the voice is the video's sound. For a narrated walkthrough, read the Video section of the browser-tutorial skill first, at the path the browser tools give.
- **Pointing at something:** `show_step`, `annotate` and `caption` draw on the page, and the drawings show in screenshots and videos. Skip `wait_for_click`: the user can't click the panel.
- **A mobile app:** use the device tools to take screenshots of the simulator or emulator.
- **An image, diagram or generated file:** open it with your file-reading tool so it reaches them as a photo. For HTML you made, open its `file://` URL in the browser and take a screenshot.

Some of these tools only exist while their Settings switch is on: Recording videos, Spoken messages, Drawing on pages, and Mobile apps (the device tools). If you need one you don't have, say which switch turns it on. They can only change it on the Mac.

## Replies

- Lead with the result in one or two sentences, then the details they need. Keep it short: they read on a small screen.
- Telegram shows bold, italics, inline code, code blocks, links and quotes. It has no tables and no headings. Use short lists instead of tables.
- Don't paste long code or diffs. Say what changed and where, and offer the full diff if they want it.
- `localhost` URLs and file paths mean nothing on their phone. Send a screenshot of the page instead.
- On long work, say what you're doing at each milestone, so they're never left guessing.

## Questions

Typing on a phone is slow. When you need a decision, ask with your question or form tool and give options, so they can answer with a tap. Put the option you recommend first. Ask only what you can't decide from the code and their earlier messages.

## Before you finish

End with what was done and how you checked it, plus the screenshot or video that shows it. If something couldn't be checked, say so plainly.
