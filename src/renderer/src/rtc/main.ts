import type { RtcCommand, RtcEvent } from '../../../shared/rtc'

/**
 * The hidden page that streams browser tabs to devices of the remote link
 * (shared/rtc.ts, main/remote/rtc.ts): it captures a tab as Chrome shares a
 * tab, and sends it over WebRTC as VP8, which encodes quickly on a CPU.
 */

declare global {
  interface Window {
    rtcHost: {
      onCommand(listener: (command: RtcCommand) => void): void
      send(event: RtcEvent): void
    }
  }
}

/** Pictures a second at most: smooth scrolling, at a cost a slow CPU keeps up with. */
const MAX_FPS = 30
/**
 * Sharpness follows what the CPU keeps up with: the tab is captured at the
 * device's pixels, encoded first at one pixel per CSS pixel, and every
 * ADAPT_MS made sharper while a picture takes under FAST_MS to encode, or
 * softer while it takes over SLOW_MS. On a laptop whose CPU ran at its
 * minimum speed, a phone-sized page at 1 played at 15 pictures a second and
 * at 2 at 2.5; a faster CPU reaches the device's own sharpness.
 */
const ADAPT_MS = 2000
const FAST_MS = 25
const SLOW_MS = 50
const STEP = 1.25

interface Stream {
  pc: RTCPeerConnection
  media?: MediaStream
  adapt?: ReturnType<typeof setInterval>
}

const streams = new Map<number, Stream>()
const send = (event: RtcEvent): void => window.rtcHost.send(event)

async function open(command: Extract<RtcCommand, { t: 'open' }>): Promise<void> {
  const { id, sourceId, width, height, ratio, iceServers } = command
  const pc = new RTCPeerConnection({ iceServers })
  const stream: Stream = { pc }
  streams.set(id, stream)
  try {
    // A tab's capture by its id: Chromium's own constraints, not the standard ones.
    const constraints = {
      audio: false,
      video: {
        mandatory: {
          chromeMediaSource: 'tab',
          chromeMediaSourceId: sourceId,
          maxWidth: width,
          maxHeight: height,
          maxFrameRate: MAX_FPS
        }
      }
    } as unknown as MediaStreamConstraints
    const media = await navigator.mediaDevices.getUserMedia(constraints)
    if (streams.get(id) !== stream) return media.getTracks().forEach((track) => track.stop())
    stream.media = media
    const [track] = media.getVideoTracks()
    // No content hint: when the connection or the CPU cannot keep up, WebRTC lowers
    // both the frame rate and the size a little (balanced), so scrolling stays smooth,
    // and goes back up as soon as it can.
    const transceiver = pc.addTransceiver(track, { direction: 'sendonly' })
    const codecs = RTCRtpSender.getCapabilities('video')?.codecs ?? []
    transceiver.setCodecPreferences([
      ...codecs.filter((codec) => codec.mimeType === 'video/VP8'),
      ...codecs.filter((codec) => codec.mimeType !== 'video/VP8')
    ])
    pc.onicecandidate = ({ candidate }) => {
      if (!candidate) return
      const { candidate: line, sdpMid, sdpMLineIndex } = candidate
      send({ t: 'candidate', id, candidate: { candidate: line, sdpMid, sdpMLineIndex } })
    }
    pc.onconnectionstatechange = () => {
      if (pc.connectionState === 'failed') fail(id, 'The connection to the device failed.')
    }
    adapt(stream, transceiver.sender, ratio)
    await pc.setLocalDescription()
    const sdp = pc.localDescription?.sdp
    if (!sdp) throw new Error('No offer was made.')
    send({ t: 'offer', id, sdp })
  } catch (error) {
    fail(id, (error as Error).message)
  }
}

/** Scale the picture down by what the CPU keeps up with, between the device's pixels and 1 per CSS pixel. */
function adapt(stream: Stream, sender: RTCRtpSender, ratio: number): void {
  let scale = Math.max(1, ratio)
  let before = { frames: 0, seconds: 0 }
  const apply = async (): Promise<void> => {
    const parameters = sender.getParameters()
    if (!parameters.encodings?.length) return
    parameters.encodings[0].scaleResolutionDownBy = scale
    await sender.setParameters(parameters).catch(() => undefined)
  }
  void apply()
  stream.adapt = setInterval(async () => {
    let now = before
    ;(await sender.getStats()).forEach((report) => {
      if (report.type === 'outbound-rtp') {
        now = { frames: report.framesEncoded ?? 0, seconds: report.totalEncodeTime ?? 0 }
      }
    })
    const frames = now.frames - before.frames
    const ms = frames > 0 ? ((now.seconds - before.seconds) / frames) * 1000 : 0
    before = now
    // A still page encodes nothing: nothing to learn.
    if (frames < 3) return
    const next =
      ms > SLOW_MS
        ? Math.min(ratio, scale * STEP)
        : ms < FAST_MS
          ? Math.max(1, scale / STEP)
          : scale
    if (next === scale) return
    scale = next
    await apply()
  }, ADAPT_MS)
}

function close(id: number): void {
  const stream = streams.get(id)
  streams.delete(id)
  clearInterval(stream?.adapt)
  stream?.media?.getTracks().forEach((track) => track.stop())
  stream?.pc.close()
}

function fail(id: number, message: string): void {
  if (!streams.has(id)) return
  close(id)
  send({ t: 'failed', id, message })
}

window.rtcHost.onCommand((command) => {
  if (command.t === 'open') return void open(command)
  const stream = streams.get(command.id)
  if (!stream) return
  if (command.t === 'close') return close(command.id)
  if (command.t === 'answer') {
    stream.pc
      .setRemoteDescription({ type: 'answer', sdp: command.sdp })
      .catch((error: Error) => fail(command.id, error.message))
  } else if (command.t === 'candidate') {
    stream.pc.addIceCandidate(command.candidate).catch(() => undefined)
  }
})

send({ t: 'ready' })
