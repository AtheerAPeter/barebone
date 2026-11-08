---
name: remote
description: Work for a user who writes from Telegram on their phone and can't see the Mac. Use when a message starts with "Remote:". It covers handing every task to a chat and deleting it once the work is confirmed done, keeping them in the loop with screenshots, narrated video demos, short replies and questions they can answer with a tap.
---

# Remote: the user is on their phone

A message that starts with `Remote:` came through Barebone's Telegram bot. The user reads your replies in Telegram and can't see the Mac: not the browser panel, not the code panel, not the terminal, not files. Everything they learn comes through the chat.

This chat has a topic of its own in their Telegram. What reaches it by itself:

- Each turn, live while you work: what you're doing, your steps, and the text you're writing. Once the turn ends it stays as one message, your last text as the answer and everything before it folded under a summary. So put what they need in your last message.
- Every image in a tool result, as a photo. That includes browser screenshots, and an image file you open with your file-reading tool.
- Every video you record with `start_recording` and `stop_recording`, as a video (up to 50 MB).
- Permission prompts and forms, as buttons.
- Cards for the chats you start with `@chats`.

Anything else you make for them (a video you rendered, a PDF, a report) goes with the `send_file` tool. Never read Barebone's data folder or its Telegram settings to send something another way. If they ask for a new name for this chat, use `rename_chat`.

## Hand every task to a chat

From Telegram, you manage and the chats you start do the work. The user asked for this, so start chats for every task without waiting for `@chats`. Each chat gets a card on their phone, so they can watch it work.

1. Start a chat with `start_chat` for each task, or one per part when the parts can be done on their own. Write each task in full, since the chat sees nothing of this conversation. Tell it to check its work and to show the result with a screenshot or a recording. Its images and videos reach the phone too.
2. Tell the user what you started, in a line or two, and end your turn. Reports arrive as new messages, so don't wait or poll.
3. When a report comes in, confirm the work is done. Read what the chat says it did and how it checked. If that leaves doubt, look yourself: open the page, run the test. If something is missing or broken, send it back to the same chat with `send_message` and end your turn again.
4. Once the work is confirmed done, tell the user the result and delete the chat with `delete_chat`.

Answer questions about the work and its status yourself; `list_chats` shows how each chat is doing. A follow-up on a task that is still open goes to its chat with `send_message`, not to a new one.

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
