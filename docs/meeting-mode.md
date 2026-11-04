# Meeting mode: the chat's agent joins a Google Meet call

Status: built 2026-11-03. Tested end to end against a local stand-in for Meet (below), in development and in the
packaged app. The first real Meet calls found four bugs, all fixed: the agent had no `speak` tool; the AI heard
only silence, twice (remote tracks need a media element; Meet decodes the call itself); and a page reload
ended the meeting and left the reloaded page without the AI's microphone and ears.

The meeting becomes part of the chat. What people say arrives in the chat as messages from the meeting, the
agent answers with the `speak` tool, whose voice goes into the call, and it sees and acts in the call with the
browser tools, like on any page. No second model decides anything.

## What the user does

1. Opens a Meet link in a chat's browser panel. A bar under the toolbar offers **Let the AI join as [name]
   [language] Join**. The name and language are remembered.
2. The tab reloads with the AI's microphone. The first time a language is used, its models download (about
   300 MB for English, German or Spanish; 32 MB for Arabic or Vietnamese, 122 MB for Japanese), shown in the bar.
3. The agent is told to join: switch Meet to the assistant's Google account if one is signed in, click Join,
   and say it is an AI.
4. It wakes when someone says its name, when the user writes in the chat, and when the call ends. Each wake
   brings what was said since the last one, with times, and a screenshot of the call.
5. **Leave** in the bar takes it out (the tab reloads, which leaves the call). When the call ends either way, the
   agent writes a summary in the chat.

Requires the voice to be on in Settings. The `speak` tool is listed whenever it is, even while the voice
downloads: agents' CLIs keep the tools their session started with. One meeting at a time. Meeting languages: English, German, Spanish
(Pocket's voice), Arabic, Japanese, Vietnamese (Supertonic's voice, slower to start).

## Parts

| Part | File | What it does |
|---|---|---|
| Meeting bar | `src/renderer/src/components/BrowserPanel.tsx` | Join form on a `meet.google.com` tab; download progress; Leave |
| Page code | `src/preload/meeting.ts` | Fake microphone, the call's audio out at 16 kHz, call end. Knows nothing about Meet |
| Meeting tab | `src/main/browser.ts` | `meeting` flag, muted while in a call, kept open between wakes (`prune`), preload only for Meet's own frames |
| Session | `src/main/meeting.ts` | Downloads, the listener process, wake rules, barge-in, speech into the call, every way it ends |
| Listener | `native/listen` | Swift program on Moonshine's streaming speech-to-text, shipped in Resources |
| Models | `src/main/meeting-models.ts`, `src/main/models.ts` | Pinned URLs, sizes and SHA-256s; the shared verified downloader |
| Voice | `src/main/speech/pocket.ts`, `worker.ts`, `index.ts` | Pocket for a chat in a meeting, Supertonic otherwise |
| Delivery | `AgentManager.fromMeeting` in `src/main/agents.ts` | A new turn, or joins the running one; not held to the cap on messages from other chats |

### Page code

Registered on the browser session like `page.ts`. It asks the app at document start (`meeting:frame`, only on
`meet.google.com`) and does nothing unless the frame is Meet's own, in a meeting tab.

- **Microphone.** `getUserMedia` returns a copy of a `MediaStreamAudioDestinationNode` track, named "Barebone" with
  device id `barebone`, the one microphone `enumerateDevices` lists. Video requests fail with `NotFoundError`, so
  Meet shows the avatar. `permissions.query` says microphone granted, camera denied. The browser still refuses
  `media` to every page (`browser.ts`), so the real microphone cannot open.
- **Speaking.** Audio pieces from the app are scheduled into that node; the page reports when a message begins and
  ends, which feeds `Speech.begun` and `Speech.ended`.
- **Listening.** Two taps, mixed in one 16 kHz `AudioContext` and sent to the app in 64 ms frames by a
  `ScriptProcessorNode` (unlike an `AudioWorklet` it needs no module, which a site's CSP could refuse):
  - What the page plays through Web Audio. `AudioNode.prototype.connect` is wrapped: whatever a page's audio
    context sends to its speakers also goes to a `MediaStreamAudioDestinationNode` of that context, which the
    ears mix in. This is how the AI hears Google Meet: Meet decodes the call in its own audio worklet (0 inputs,
    3 outputs, one per audio slot), so its WebRTC tracks carry packets but never a decoded sample.
  - Every incoming WebRTC audio track, for sites that play the call the usual way. `RTCPeerConnection` is
    subclassed. Each track also plays in a muted audio element outside the page: Chromium passes a remote
    track's audio to Web Audio only while a media element plays it.
- **Call end.** When every connection that carried audio has closed and the page is still there a second later.
  A page that reloads or goes away closes them as it goes, and its report never fires, so a reload stays in
  the meeting and the reloaded page gets the microphone and ears again. The tab leaving `meet.google.com` ends
  the meeting. A connection that never carried audio (a network check before the call) neither starts nor ends it.

### Listener

`barebone-listen <model dir> <tiny-streaming|small-streaming> [name]`: 16 kHz float32 on stdin, JSON lines out
(`ready`, `started`, `completed` with text, start and duration). The name goes to Moonshine's key terms so it is
spelled right. Built by `npm run build:listen` (part of `npm run build:mac`) with `moonshine-swift` 0.1.5; the
app downloads and checks its models itself, because Moonshine's own downloader checks no checksums.

### Wakes and barge-in

- A completed line containing the name, as a word of its own (case and accents ignored, any script), wakes the
  agent. While the meeting ends, the listener's last lines only go into the final message.
- The user's message in the chat: what was said first, as its own message, then theirs.
- Someone starting a line while the AI speaks stops its voice (`speech.stop`); the next wake says what it was
  saying. Measured: about 1.1 s from the interruption to silence.
- The first wake gives the agent the rules once: join, introduce itself, answer only with `speak` in the call's
  language, one to three plain sentences, say nothing when not asked, summary at the end.

### Voice

`Speech.speak` uses Pocket when the chat is the meeting's and the language is one of Pocket's three; its audio
goes to the meeting tab instead of the window (the `audio` callback in `index.ts`). Pocket runs in the speech
process on one thread (more threads were slower), from lineofflight's ONNX bundles of Kyutai's current models,
with the voices lineofflight tested: charles (English), juergen (German), lola (Spanish). KevinAHM's `german`
bundle is Kyutai's April model and babbles with today's voices.

## Measured

| What | Result |
|---|---|
| End of a question to text (Moonshine small) | 0.3 to 0.8 s |
| `speak` to first audio (Pocket) | 70 to 110 ms; Supertonic 0.9 to 3.9 s |
| End of a question to the AI's voice in the call (DeepSeek V4.1 Flash on OpenCode) | 3 to 5 s |
| Talked over to silence | about 1.1 s |
| Memory during a call | listener about 1.2 GB, Pocket about 0.8 GB |

## Testing

`~/Desktop/code/meeting-stt-spike/standin` has a stand-in for Meet served as `https://meet.google.com` to a test
instance, with a recorded two-person meeting, and how to run it. The spikes behind the choices are in
`~/Desktop/code/meeting-stt-spike` (Moonshine) and `~/Desktop/code/pocket-tts-spike` (Pocket against
Supertonic).

## Not done

- A real Google Meet call. Things the stand-in cannot show: Meet's pre-join and account switcher under the agent,
  Meet's compressed audio and people talking over each other, and whether Meet opens connections the call-end
  rule misreads.
- Names of who said each line: the screenshot at each wake is all the agent has.
