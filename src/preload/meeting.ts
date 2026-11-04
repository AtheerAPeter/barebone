import { contextBridge, ipcRenderer } from 'electron'

/**
 * Runs in every frame of the built-in browser's pages, and does nothing
 * unless the app put the tab in a meeting (main/meeting.ts) and the frame is
 * the meeting's own. Then it gives the page the AI's ears and mouth, with no
 * knowledge of the meeting's site:
 *
 * - A microphone that is the AI's voice. getUserMedia gets a track of what
 *   the app plays in, never a device: the browser grants pages no microphone
 *   (main/browser.ts) and this never asks for one. There is no camera.
 * - Its ears: what the page plays (through Web Audio, which is how Google
 *   Meet plays a call) and every incoming WebRTC audio track (how most sites
 *   do), mixed and resampled to 16 kHz, go to the app, which transcribes it.
 * - When every connection of the call has closed and the page stays, the
 *   call is over.
 */

type Speech = { id: string; samples: Float32Array<ArrayBuffer>; sampleRate: number; last: boolean }
type Stop = { id?: string; chatId?: string }

interface Bridge {
  /** 16 kHz mono samples of what the call says. */
  heard: (samples: Float32Array) => void
  ended: () => void
  /** A message of the AI's began or ended playing into the call. */
  played: (id: string, event: 'begun' | 'ended') => void
  /** Be told what the AI says, and when to stop saying it. */
  listen: (play: (piece: Speech) => void, stop: (which: Stop) => void) => void
}

// Asked of the app only on the meeting's site, so other pages pay nothing.
if (location.hostname === 'meet.google.com' && ipcRenderer.sendSync('meeting:frame') === true) {
  const bridge: Bridge = {
    heard: (samples) => ipcRenderer.send('meeting:heard', samples),
    ended: () => ipcRenderer.send('meeting:ended'),
    played: (id, event) => ipcRenderer.send('meeting:played', id, event),
    listen: (play, stop) => {
      ipcRenderer.on('meeting:play', (_event, piece: Speech) => play(piece))
      ipcRenderer.on('meeting:stop', (_event, which: Stop) => stop(which))
    }
  }
  contextBridge.executeInMainWorld({
    // Runs in the page itself, before its scripts: it uses nothing from out here.
    func: (bridge: Bridge) => {
      // --- Mouth: a microphone that plays what the AI says -----------------
      const voice = new AudioContext()
      const microphone = voice.createMediaStreamDestination()
      // Mono, as a microphone is: a stereo track would make the site send stereo.
      microphone.channelCount = 1
      microphone.channelCountMode = 'explicit'
      /** When the next piece starts, in the context's time. */
      let playhead = 0
      const playing = new Map<string, AudioBufferSourceNode[]>()
      const timers = new Map<string, number[]>()
      const at = (id: string, time: number, run: () => void): void => {
        const delay = Math.max(0, (time - voice.currentTime) * 1000)
        timers.set(id, [...(timers.get(id) ?? []), window.setTimeout(run, delay)])
      }
      bridge.listen(
        ({ id, samples, sampleRate, last }) => {
          void voice.resume()
          // A little ahead, so a piece that arrives late does not click.
          if (playhead < voice.currentTime) playhead = voice.currentTime + 0.05
          if (!playing.has(id)) {
            playing.set(id, [])
            at(id, playhead, () => bridge.played(id, 'begun'))
          }
          if (samples.length > 0) {
            const buffer = voice.createBuffer(1, samples.length, sampleRate)
            buffer.copyToChannel(samples, 0)
            const source = voice.createBufferSource()
            source.buffer = buffer
            source.connect(microphone)
            source.start(playhead)
            playhead += buffer.duration
            playing.get(id)!.push(source)
          }
          if (last) {
            at(id, playhead, () => {
              playing.delete(id)
              timers.delete(id)
              bridge.played(id, 'ended')
            })
          }
        },
        (which) => {
          // What one message, or everything, was going to say: the chat is one.
          for (const id of [...playing.keys()]) {
            if (which.id && which.id !== id) continue
            for (const source of playing.get(id)!) source.stop()
            for (const timer of timers.get(id) ?? []) clearTimeout(timer)
            playing.delete(id)
            timers.delete(id)
          }
          if (playing.size === 0) playhead = voice.currentTime
        }
      )

      const devices = navigator.mediaDevices
      const enumerate = devices.enumerateDevices.bind(devices)
      const fakeMicrophone = {
        deviceId: 'barebone',
        groupId: 'barebone',
        kind: 'audioinput',
        label: 'Barebone',
        toJSON() {
          return {
            deviceId: 'barebone',
            groupId: 'barebone',
            kind: 'audioinput',
            label: 'Barebone'
          }
        }
      } as MediaDeviceInfo
      // Only this microphone, no camera; speakers as they are.
      devices.enumerateDevices = async () => [
        fakeMicrophone,
        ...(await enumerate()).filter((device) => device.kind === 'audiooutput')
      ]
      devices.getUserMedia = async (constraints?: MediaStreamConstraints) => {
        // No camera, as enumerateDevices says: the call shows the avatar.
        if (constraints?.video)
          throw new DOMException('Requested device not found', 'NotFoundError')
        if (!constraints?.audio) throw new TypeError('getUserMedia needs audio or video')
        void voice.resume()
        // Each caller gets its own copy, which it may stop or mute (its mute button) alone.
        // It is the microphone enumerateDevices lists, by name and by id.
        const track = microphone.stream.getAudioTracks()[0].clone()
        const settings = track.getSettings.bind(track)
        Object.defineProperty(track, 'label', { value: 'Barebone' })
        track.getSettings = () => ({ ...settings(), deviceId: 'barebone', groupId: 'barebone' })
        return new MediaStream([track])
      }
      const query = navigator.permissions.query.bind(navigator.permissions)
      navigator.permissions.query = async (descriptor: PermissionDescriptor) => {
        const name = descriptor.name as string
        if (name !== 'microphone' && name !== 'camera') return query(descriptor)
        const status = new EventTarget() as PermissionStatus
        Object.defineProperties(status, {
          name: { value: name },
          state: { value: name === 'microphone' ? 'granted' : 'denied' },
          onchange: { value: null, writable: true }
        })
        return status
      }

      // --- Ears: every incoming audio track, mixed, at 16 kHz ---------------
      const ears = new AudioContext({ sampleRate: 16000 })
      const mix = ears.createGain()
      // A script processor needs no module, which the site's CSP could refuse.
      const tap = ears.createScriptProcessor(1024, 1, 1)
      tap.onaudioprocess = (event) => bridge.heard(event.inputBuffer.getChannelData(0).slice())
      mix.connect(tap)
      // It only runs while connected to an output; it writes nothing, and the tab is muted.
      tap.connect(ears.destination)

      // What the page plays through Web Audio, the AI hears too: whatever a
      // page's audio context sends to its speakers also goes to a stream of
      // that context, which the ears mix in. Google Meet plays the call this
      // way, decoding it in its own audio worklet: its WebRTC tracks below
      // stay silent. The tab is muted, so the speakers play nothing.
      const ours = new Set<BaseAudioContext>([voice, ears])
      const mirrors = new WeakMap<BaseAudioContext, MediaStreamAudioDestinationNode>()
      const connect = AudioNode.prototype.connect as (
        this: AudioNode,
        destination: AudioNode,
        output?: number,
        input?: number
      ) => AudioNode
      const disconnect = AudioNode.prototype.disconnect as (
        this: AudioNode,
        ...args: unknown[]
      ) => void
      const mirror = (node: AudioNode): MediaStreamAudioDestinationNode | undefined => {
        const context = node.context
        if (ours.has(context) || !(context instanceof AudioContext)) return undefined
        let stream = mirrors.get(context)
        if (!stream) {
          stream = context.createMediaStreamDestination()
          mirrors.set(context, stream)
          void ears.resume()
          ears.createMediaStreamSource(stream.stream).connect(mix)
        }
        return stream
      }
      AudioNode.prototype.connect = function (
        this: AudioNode,
        destination: AudioNode | AudioParam,
        output?: number,
        input?: number
      ) {
        const result = connect.call(this, destination as AudioNode, output, input)
        if (destination instanceof AudioDestinationNode) {
          const stream = mirror(this)
          if (stream) connect.call(this, stream, output ?? 0)
        }
        return result
      } as typeof AudioNode.prototype.connect
      AudioNode.prototype.disconnect = function (this: AudioNode, ...args: unknown[]) {
        disconnect.apply(this, args)
        // Taken from the speakers, it is taken from the AI's ears too.
        const stream = mirrors.get(this.context)
        if (stream && args[0] instanceof AudioDestinationNode) {
          try {
            disconnect.call(this, stream)
          } catch {
            // It was not connected to them.
          }
        }
      } as typeof AudioNode.prototype.disconnect

      // The call: connections that carry its audio. A connection without any
      // (a site checking the network before the call) neither starts nor ends it.
      // The call is over when they have all closed and the page is still here
      // a moment later: a page that reloads or goes away closes them as it
      // goes, and its timer never fires. The page that loads next can be in
      // the call again (main/meeting.ts ends the meeting when the tab leaves
      // the site).
      const calls = new Set<RTCPeerConnection>()
      let inCall = false
      let over = false
      const check = (): void => {
        const open = [...calls].some(
          (c) => c.connectionState !== 'closed' && c.connectionState !== 'failed'
        )
        if (open || !inCall || over) return
        setTimeout(() => {
          if (over || [...calls].some((c) => c.connectionState === 'connected')) return
          over = true
          bridge.ended()
        }, 1000)
      }
      /** The elements playing the call's tracks, kept while they play. */
      const sinks = new Set<HTMLAudioElement>()
      const Native = window.RTCPeerConnection
      class Connection extends Native {
        constructor(...args: ConstructorParameters<typeof RTCPeerConnection>) {
          super(...args)
          this.addEventListener('track', (event) => {
            if (event.track.kind !== 'audio') return
            calls.add(this)
            const stream = new MediaStream([event.track])
            // Chromium passes a remote track's audio to Web Audio only while a
            // media element plays it too, which a site playing the call through
            // Web Audio alone does not do: so this one does, muted, outside the page.
            const sink = new Audio()
            sink.muted = true
            sink.srcObject = stream
            sinks.add(sink)
            void sink.play().catch(() => undefined)
            event.track.addEventListener('ended', () => sinks.delete(sink))
            void ears.resume()
            ears.createMediaStreamSource(stream).connect(mix)
          })
          this.addEventListener('connectionstatechange', () => {
            if (!calls.has(this)) return
            if (this.connectionState === 'connected') inCall = true
            check()
          })
          const close = this.close.bind(this)
          this.close = () => {
            close()
            if (calls.has(this)) check()
          }
        }
      }
      window.RTCPeerConnection = Connection
    },
    args: [bridge]
  })
}
